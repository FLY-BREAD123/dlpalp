'use strict';
// ⚔️ 피파 전쟁 봇 — Render 무료 웹서비스용
//   /전쟁 상대:@친구  (또는 "@친구 피파전쟁")  →  상대 DM + 경보 채널 사이렌 → 수락 → 스코어 입력 → 상대 확인 → 리그 반영

const cfg = require('./config');
const { Client, GatewayIntentBits, Events, ActivityType, Options, MessageFlags } = require('discord.js');
const { Store } = require('./store');
const war = require('./war');
const commands = require('./commands');
const text = require('./text');
const web = require('./web');

const runtime = { client: null, status: 'starting', error: '', textEnabled: false };
const store = new Store(() => runtime.client);

war.init({ store, getClient: () => runtime.client });
commands.init({ store, runtime });
text.init({ store, runtime });

// 포트부터 연다 → Render가 배포 성공으로 인식
web.start({ runtime, store });

// ───────── 토큰 점검 (지난번 TokenInvalid 대비) ─────────
function tokenProblem(token) {
  if (!token) return 'DISCORD_TOKEN 이 비어 있어요. Render → Environment 에 봇 토큰을 넣어주세요.';
  if (/[^\x21-\x7e]/.test(token)) return 'DISCORD_TOKEN 에 이상한 글자가 있어요 (예시값 그대로?). Developer Portal → Bot 탭의 토큰을 넣어주세요.';
  if (/^\d{15,22}$/.test(token)) return '숫자만 있는 값은 Application ID 예요. Developer Portal → Bot → Reset Token 으로 받은 토큰을 넣어주세요.';
  if (!token.includes('.')) return '점(.)이 없는 값은 Client Secret 이에요. Developer Portal → Bot 탭의 토큰을 넣어주세요.';
  if (token.split('.').length !== 3) return '토큰 형식이 이상해요 (xxx.yyy.zzz 형태). 다시 복사해서 넣어주세요.';
  return '';
}

function fail(msg) {
  runtime.status = 'error';
  runtime.error = msg;
  console.error(`[bot] ❌ ${msg}`);
}

// ───────── 클라이언트 ─────────
async function setupGuild(guild) {
  try {
    const st = await store.ensure(guild.id);
    war.rearm(guild.id);
    await commands.register(guild);
    const info = store.info(guild.id);
    console.log(
      `[store] ${guild.name}: ${
        info.mode === 'discord' ? `#${info.channelName} 백업 사용` : '⚠️ 로컬 저장만 (재시작 시 초기화 위험)'
      } · 플레이어 ${Object.keys(st.players).length}명 · 진행 중 ${Object.keys(st.active).length}건`,
    );
  } catch (err) {
    console.error(`[setup] ${guild.name} 준비 실패:`, err);
  }
}

async function route(i) {
  if (i.isChatInputCommand()) return commands.handle(i);
  if (i.isButton() && i.customId.startsWith('fw|')) return war.handleButton(i);
  if (i.isModalSubmit() && i.customId.startsWith('fwm|')) return war.handleModal(i);
}

async function interactionError(i, err) {
  console.error('[bot] 상호작용 오류:', err);
  if (!i.isRepliable()) return;
  const payload = { content: '⚠️ 처리 중 오류가 났어요. 잠시 후 다시 시도해주세요.', flags: MessageFlags.Ephemeral };
  try {
    if (i.deferred || i.replied) await i.followUp(payload);
    else await i.reply(payload);
  } catch {
    /* 이미 만료된 상호작용 */
  }
}

function createClient(withContent) {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
  if (withContent) intents.push(GatewayIntentBits.MessageContent);

  const client = new Client({
    intents,
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 50 }),
    sweepers: Options.DefaultSweeperSettings,
    presence: { activities: [{ name: 'fifa', type: ActivityType.Custom, state: '⚔️ /전쟁 으로 피파 전쟁 선포' }] },
  });

  client.once(Events.ClientReady, async (c) => {
    runtime.status = 'online';
    runtime.error = '';
    console.log(`[bot] ✅ ${c.user.tag} 로그인 · 서버 ${c.guilds.cache.size}개 · 텍스트 명령 ${withContent ? 'ON' : 'OFF'}`);
    if (!c.guilds.cache.size) {
      console.log(
        `[bot] 아직 들어간 서버가 없어요. 초대 링크:\n      https://discord.com/oauth2/authorize?client_id=${c.user.id}&scope=bot%20applications.commands&permissions=248912`,
      );
    }
    await Promise.all(c.guilds.cache.map((g) => setupGuild(g)));
  });
  client.on(Events.GuildCreate, (g) => setupGuild(g));
  client.on(Events.InteractionCreate, (i) => route(i).catch((err) => interactionError(i, err)));
  if (withContent) {
    client.on(Events.MessageCreate, (m) => text.handle(m).catch((err) => console.error('[text] 오류:', err)));
  }
  client.on(Events.Error, (err) => console.error('[bot] 클라이언트 오류:', err.message));
  client.on(Events.ShardDisconnect, (ev) => {
    runtime.status = 'reconnecting';
    console.warn(`[bot] 게이트웨이 연결 끊김 (code ${ev?.code})`);
  });
  client.on(Events.ShardReconnecting, () => {
    runtime.status = 'reconnecting';
  });
  client.on(Events.ShardResume, () => {
    runtime.status = 'online';
  });
  client.on(Events.ShardReady, () => {
    runtime.status = 'online';
  });
  return client;
}

async function start() {
  const problem = tokenProblem(cfg.TOKEN);
  if (problem) return fail(problem);

  let withContent = cfg.TEXT_COMMANDS;
  let attempt = 0;
  for (;;) {
    const client = createClient(withContent);
    runtime.client = client;
    try {
      await client.login(cfg.TOKEN);
      runtime.textEnabled = withContent;
      return;
    } catch (err) {
      const msg = String(err?.message || err);
      if (withContent && (err?.code === 'DisallowedIntents' || /disallowed intents|privileged intent/i.test(msg))) {
        console.warn(
          '[bot] ⚠️ MESSAGE CONTENT INTENT 가 꺼져 있어서 텍스트 명령 없이 슬래시 명령만으로 실행합니다.\n' +
            '      "@상대 피파전쟁" 도 쓰려면: Developer Portal → Bot → MESSAGE CONTENT INTENT 켜기 → Render에서 재시작',
        );
        withContent = false;
        continue;
      }
      if (err?.code === 'TokenInvalid' || /invalid token|401/i.test(msg)) {
        return fail(
          '토큰이 틀렸어요 (TokenInvalid). Developer Portal → Bot → Reset Token 으로 새 토큰을 받아 Render 환경변수 DISCORD_TOKEN 에 따옴표 없이 붙여넣으세요.',
        );
      }
      attempt += 1;
      const wait = Math.min(60000, 5000 * attempt);
      runtime.status = 'error';
      runtime.error = `디스코드 접속 실패: ${msg} (${wait / 1000}초 후 재시도)`;
      console.error(`[bot] 로그인 실패: ${msg} → ${wait / 1000}초 후 재시도`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// ───────── 종료 시 저장 (Render 재배포/재시작 = SIGTERM) ─────────
let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  console.log(`[bot] ${sig} 수신 → 저장 후 종료`);
  await Promise.race([store.flushAll(), new Promise((r) => setTimeout(r, 8000))]).catch(() => {});
  await runtime.client?.destroy().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('[bot] 처리 안 된 오류:', err));

start();
