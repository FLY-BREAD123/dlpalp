'use strict';
// ⚔️ 전쟁 흐름: 선포 → (DM + 경보) → 수락/도망 → 결과 입력 → 상대 확인/이의제기 → 확정
// 진행 중인 전쟁도 저장소에 기록 → Render가 재시작돼도 버튼·타이머가 이어짐

const { MessageFlags } = require('discord.js');
const cfg = require('./config');
const L = require('./league');
const V = require('./views');

const EPH = MessageFlags.Ephemeral;
const NONE = { parse: [] };

let store = null;
let getClient = () => null;
const timers = new Map();
const cooldowns = new Map();

function init(deps) {
  store = deps.store;
  getClient = deps.getClient;
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const other = (m, uid) => (uid === m.a ? m.b : m.a);
const findActiveFor = (st, uid) => Object.values(st.active).find((m) => m.a === uid || m.b === uid);

// ───────── 메시지 참조 헬퍼 (DM ↔ 서버 채널 양쪽 동기화) ─────────
async function editRef(ref, payload) {
  if (!ref) return null;
  try {
    const ch = await getClient().channels.fetch(ref.channelId);
    return await ch.messages.edit(ref.messageId, { allowedMentions: NONE, ...payload });
  } catch (err) {
    console.warn('[war] 메시지 수정 실패:', err.message);
    return null;
  }
}

async function sendRef(ref, payload) {
  if (!ref) return null;
  try {
    const ch = await getClient().channels.fetch(ref.channelId);
    return await ch.send(payload);
  } catch (err) {
    console.warn('[war] 메시지 전송 실패:', err.message);
    return null;
  }
}

function deny(i, content) {
  return i.reply({ content, flags: EPH, allowedMentions: NONE }).catch(() => {});
}

// ───────── 타이머 ─────────
const tkey = (m) => `${m.guildId}:${m.id}`;

function clearTimer(m) {
  const k = tkey(m);
  clearTimeout(timers.get(k));
  timers.delete(k);
}

function arm(m) {
  clearTimer(m);
  const delay = Math.max(0, Math.min(m.deadline - Date.now(), 2 ** 31 - 1));
  timers.set(
    tkey(m),
    setTimeout(() => {
      onDeadline(m.guildId, m.id).catch((err) => console.error('[war] 타이머 처리 오류:', err));
    }, delay),
  );
}

function rearm(guildId) {
  const st = store.peek(guildId);
  if (!st) return;
  for (const m of Object.values(st.active)) arm(m);
}

async function onDeadline(gid, mid) {
  timers.delete(`${gid}:${mid}`);
  const st = store.peek(gid);
  const m = st?.active[mid];
  if (!m) return;
  if (Date.now() < m.deadline - 1000) return arm(m); // 마감이 연장된 경우
  if (m.status === 'confirming') return finalize(st, m, { auto: true });

  delete st.active[mid];
  store.touch(gid);
  if (m.status === 'pending') {
    await editRef(m.alert, V.closedPayload(m, st, 'expire'));
    await editRef(m.dm, V.dmNotePayload(m, '⌛ 응답 시간 초과', '전쟁이 무산됐어요.'));
  } else {
    await editRef(m.alert, V.closedPayload(m, st, 'void'));
    await editRef(m.dm, V.dmNotePayload(m, '⌛ 경기 무효', '결과가 입력되지 않아 무효 처리됐어요.'));
  }
}

// ───────── 선포 ─────────
async function resolveAlertChannel(guild, st, fallback) {
  const id = st.settings.alertChannelId || cfg.ALERT_CHANNEL_ID;
  if (id && id !== fallback?.id) {
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (ch && typeof ch.send === 'function') return ch;
  }
  return fallback || null;
}

/**
 * src = {
 *   kind: 'slash' | 'text', interaction?, message?, guild, channel,
 *   a: { user, member },  // 선포자
 *   b: { user, member },  // 상대
 * }
 * slash는 호출 전에 deferReply(ephemeral) 되어 있어야 함
 */
async function declareWar(src) {
  const { guild, a, b } = src;
  const say = (content) =>
    src.kind === 'slash'
      ? src.interaction.editReply({ content, allowedMentions: NONE }).catch(() => {})
      : src.message.reply({ content, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});

  if (!b?.user) return say('⚔️ 전쟁을 걸 상대를 지정해주세요! 예: `/전쟁 상대:@친구`');
  if (b.user.id === a.user.id) return say('😅 자기 자신과는 전쟁할 수 없어요.');
  if (b.user.bot) return say('🤖 봇이랑은 피파 못 해요...');

  const left = (cooldowns.get(a.user.id) || 0) + cfg.TIMING.cooldownMs - Date.now();
  if (left > 0) return say(`⏳ ${Math.ceil(left / 1000)}초 뒤에 다시 선포할 수 있어요.`);

  const st = await store.ensure(guild.id);
  const busy = findActiveFor(st, a.user.id) || findActiveFor(st, b.user.id);
  if (busy) {
    const who = busy.a === a.user.id || busy.b === a.user.id ? '나는' : '상대는';
    const link = V.alertUrl(busy);
    return say(`⚠️ ${who} 이미 전쟁 중이에요 (${V.statusLabel(busy.status)})${link ? `\n↪ ${link}` : ''}`);
  }

  // ── 여기서부터 await 전에 자리 확보 (동시 선포 방지)
  const now = Date.now();
  const infoA = V.infoOf(a.user, a.member);
  const infoB = V.infoOf(b.user, b.member);
  L.ensurePlayer(st, a.user.id, infoA);
  L.ensurePlayer(st, b.user.id, infoB);
  const m = {
    id: newId(),
    guildId: guild.id,
    a: a.user.id,
    b: b.user.id,
    names: { [a.user.id]: infoA.name, [b.user.id]: infoB.name },
    avatars: { [a.user.id]: infoA.avatar, [b.user.id]: infoB.avatar },
    status: 'pending',
    createdAt: now,
    deadline: now + cfg.TIMING.challengeMs,
    taunt: V.taunt(infoA.name, infoB.name),
    alert: null,
    dm: null,
    dmBlocked: false,
    report: null,
    disputes: 0,
    note: '',
  };
  st.active[m.id] = m;
  cooldowns.set(a.user.id, now);

  // 1) 경보 채널 사이렌
  const roleId = st.settings.alertRoleId || cfg.ALERT_ROLE_ID;
  const alertPayload = {
    ...V.challengePayload(m, st),
    content: `${roleId ? `<@&${roleId}> ` : ''}🚨 **삐용삐용! 피파 전쟁 경보!** 🚨 <@${m.b}>`,
    allowedMentions: { users: [m.b], roles: roleId ? [roleId] : [] },
  };
  const alertCh = await resolveAlertChannel(guild, st, src.channel);
  let alertMsg = null;
  if (alertCh) {
    alertMsg = await alertCh.send(alertPayload).catch((err) => {
      console.warn(`[war] 경보 채널(#${alertCh.name}) 전송 실패: ${err.message}`);
      return null;
    });
  }
  if (!alertMsg) {
    // 채널 권한 없을 때 → 명령어 응답으로라도 경보
    alertMsg =
      src.kind === 'slash'
        ? await src.interaction.followUp(alertPayload).catch(() => null)
        : await src.message.reply(alertPayload).catch(() => null);
  }
  if (!alertMsg) {
    delete st.active[m.id];
    cooldowns.delete(a.user.id);
    return say('❌ 경보를 보낼 수 없어요. 봇에게 이 채널 **메시지 보내기 · 링크 첨부** 권한이 있는지 확인해주세요.');
  }
  m.alert = { channelId: alertMsg.channelId, messageId: alertMsg.id };

  // 2) 상대 DM — "A님이 B님한테 축구 전쟁을 걸었습니다"
  const dm = await b.user.send(V.dmChallengePayload(m, st, guild.name)).catch(() => null);
  if (dm) {
    m.dm = { channelId: dm.channelId, messageId: dm.id };
  } else {
    m.dmBlocked = true;
    await alertMsg.edit({ embeds: V.challengePayload(m, st).embeds }).catch(() => {});
  }

  store.touch(guild.id);
  arm(m);

  // 3) 선포자 응답
  if (src.kind === 'slash') {
    const where = alertMsg.channelId === src.channel?.id ? '' : ` <#${alertMsg.channelId}> 에`;
    await src.interaction
      .editReply({
        content: `⚔️ 선포 완료!${where} 경보가 울렸습니다.${m.dmBlocked ? '\n⚠️ 상대 DM이 막혀 있어서 경보 메시지로만 알렸어요.' : ''}`,
        allowedMentions: NONE,
      })
      .catch(() => {});
  } else {
    await src.message.react('⚔️').catch(() => {});
  }
}

// ───────── 버튼 ─────────
async function handleButton(i) {
  const [, act, gid, mid] = i.customId.split('|');
  const st = await store.ensure(gid);
  const m = st.active[mid];
  if (!m) {
    // 끝난 전쟁의 버튼 → 버튼 지우고 안내
    return i
      .update({ components: [] })
      .then(() => i.followUp({ content: '⌛ 이미 끝났거나 만료된 전쟁이에요.', flags: EPH }))
      .catch(() => deny(i, '⌛ 이미 끝났거나 만료된 전쟁이에요.'));
  }
  const uid = i.user.id;
  const party = uid === m.a || uid === m.b;

  switch (act) {
    case 'acc':
    case 'run':
      if (uid !== m.b) {
        return deny(i, uid === m.a ? '😏 내가 건 전쟁은 상대가 응답해야죠.' : `이 전쟁은 <@${m.b}> 님만 응답할 수 있어요.`);
      }
      if (m.status !== 'pending') return deny(i, '이미 응답한 전쟁이에요.');
      return act === 'acc' ? accept(i, st, m) : runAway(i, st, m);

    case 'rep':
      if (!party) return deny(i, '전쟁 당사자만 결과를 입력할 수 있어요.');
      if (m.status === 'confirming' && m.report?.by !== uid) {
        return deny(i, '상대가 이미 결과를 냈어요. **✅ 확인** 또는 **⚠️ 이의제기**를 눌러주세요.');
      }
      if (m.status !== 'playing' && m.status !== 'confirming') return deny(i, '지금은 결과를 입력할 수 없어요.');
      return i.showModal(V.reportModal(m, st));

    case 'ok':
    case 'obj':
      if (!party) return deny(i, '전쟁 당사자만 누를 수 있어요.');
      if (m.status !== 'confirming' || !m.report) return deny(i, '확인할 결과가 없어요.');
      if (m.report.by === uid) return deny(i, `⏳ <@${other(m, uid)}> 님이 확인해야 해요. (${V.ts(m.deadline)} 자동 확정)`);
      return act === 'ok' ? finalize(st, m, { interaction: i }) : dispute(i, st, m);

    case 'cxl':
      if (!party) return deny(i, '전쟁 당사자만 취소할 수 있어요.');
      if (m.status === 'confirming') return deny(i, '결과 확인 중엔 취소할 수 없어요. 결과가 틀렸으면 **⚠️ 이의제기**를 먼저 눌러주세요.');
      if (m.status !== 'playing') return deny(i, '지금은 취소할 수 없어요.');
      return cancel(i, st, m);

    default:
      return deny(i, '알 수 없는 버튼이에요.');
  }
}

async function accept(i, st, m) {
  const now = Date.now();
  m.status = 'playing';
  m.acceptedAt = now;
  m.deadline = now + cfg.TIMING.matchMs;
  store.touch(m.guildId);
  arm(m);

  const guildName = getClient()?.guilds.cache.get(m.guildId)?.name || '서버';
  const alertPayload = V.matchPayload(m, st);
  const dmPayload = V.dmNotePayload(
    m,
    '✅ 전쟁 수락!',
    `**${V.esc(guildName)}** 경보 메시지에서 경기 끝나고 **📝 결과 입력** 누르면 돼요.\n행운을 빌어요 ⚽`,
    cfg.COLORS.win,
    '⚽ 경기 메시지로 이동',
  );
  if (i.inGuild()) {
    await i.update(alertPayload);
    await editRef(m.dm, dmPayload);
  } else {
    await i.update(dmPayload);
    await editRef(m.alert, alertPayload);
  }
  // 선포자 호출
  await sendRef(m.alert, {
    content: `⚽ <@${m.a}> 님! <@${m.b}> 님이 전쟁을 **수락**했습니다. 킥오프!\n끝나면 위 메시지의 **📝 결과 입력**으로 스코어를 올려주세요.`,
    allowedMentions: { users: [m.a] },
    reply: { messageReference: m.alert.messageId, failIfNotExists: false },
  });
}

async function runAway(i, st, m) {
  delete st.active[m.id];
  clearTimer(m);
  const p = L.ensurePlayer(st, m.b);
  p.runs += 1;
  store.touch(m.guildId);

  const alertPayload = V.closedPayload(m, st, 'run', { roast: V.roast(), runs: p.runs });
  const dmPayload = V.dmNotePayload(m, '🏳️ 도망쳤습니다...', `서버에 소문 다 났어요 🐔 (도망 누적 ${p.runs}회)`);
  if (i.inGuild()) {
    await i.update(alertPayload);
    await editRef(m.dm, dmPayload);
  } else {
    await i.update(dmPayload);
    await editRef(m.alert, alertPayload);
  }
}

async function dispute(i, st, m) {
  const now = Date.now();
  const reporter = m.report.by;
  const old = `${m.report.sa}:${m.report.sb}`;
  m.status = 'playing';
  m.report = null;
  m.disputes += 1;
  m.note = `⚠️ <@${i.user.id}> 님이 결과(${old})에 이의제기! 다시 입력해주세요.`;
  m.deadline = Math.max((m.acceptedAt || now) + cfg.TIMING.matchMs, now + cfg.TIMING.disputeGraceMs);
  store.touch(m.guildId);
  arm(m);

  await i.update(V.matchPayload(m, st));
  await i
    .followUp({
      content: `<@${reporter}> 이의제기가 들어왔어요. 스코어 다시 확인하고 **📝 결과 입력** 해주세요!`,
      allowedMentions: { users: [reporter] },
    })
    .catch(() => {});
}

async function cancel(i, st, m) {
  delete st.active[m.id];
  clearTimer(m);
  store.touch(m.guildId);
  await i.update(V.closedPayload(m, st, 'cancel', { by: i.user.id }));
  await editRef(m.dm, V.dmNotePayload(m, '❌ 경기 취소', `<@${i.user.id}> 님이 경기를 취소했어요. 전적엔 반영되지 않아요.`));
}

async function finalize(st, m, { interaction = null, auto = false } = {}) {
  if (m.status !== 'confirming' || !m.report || st.active[m.id] !== m) return;
  delete st.active[m.id];
  clearTimer(m);
  m.status = 'done';
  const res = L.applyResult(st, {
    id: m.id,
    a: m.a,
    b: m.b,
    sa: m.report.sa,
    sb: m.report.sb,
    at: Date.now(),
    infoA: { name: m.names?.[m.a], avatar: m.avatars?.[m.a] },
    infoB: { name: m.names?.[m.b], avatar: m.avatars?.[m.b] },
  });
  store.touch(m.guildId);

  const payload = V.resultPayload(m, st, res, { auto });
  if (interaction) {
    await interaction.update(payload).catch(async (err) => {
      console.warn('[war] 결과 표시 실패 → 직접 수정:', err.message);
      await editRef(m.alert, payload);
    });
  } else {
    await editRef(m.alert, payload);
  }
  await editRef(m.dm, V.dmResultPayload(m, st, res));
  if (res.events.length) await sendRef(m.alert, { embeds: [V.newsEmbed(res.events)], allowedMentions: NONE });
}

// ───────── 결과 입력 모달 ─────────
function parseScore(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{1,2}$/.test(s)) return null;
  return Number(s);
}

async function handleModal(i) {
  const [, gid, mid] = i.customId.split('|');
  const st = await store.ensure(gid);
  const m = st.active[mid];
  if (!m) return deny(i, '⌛ 이미 끝났거나 만료된 전쟁이에요.');
  const uid = i.user.id;
  if (uid !== m.a && uid !== m.b) return deny(i, '전쟁 당사자만 결과를 입력할 수 있어요.');
  if (!(m.status === 'playing' || (m.status === 'confirming' && m.report?.by === uid))) {
    return deny(i, '지금은 결과를 입력할 수 없어요. (상대가 먼저 제출했으면 확인/이의제기를 눌러주세요)');
  }
  const sa = parseScore(i.fields.getTextInputValue('sa'));
  const sb = parseScore(i.fields.getTextInputValue('sb'));
  if (sa === null || sb === null) return deny(i, '❌ 점수는 0~99 숫자만 입력해주세요.');

  const now = Date.now();
  m.report = { by: uid, sa, sb, at: now };
  m.status = 'confirming';
  m.deadline = now + cfg.TIMING.confirmMs;
  m.note = '';
  store.touch(gid);
  arm(m);

  const payload = V.matchPayload(m, st);
  if (i.isFromMessage()) await i.update(payload);
  else {
    await i.reply({ content: '📝 제출 완료!', flags: EPH });
    await editRef(m.alert, payload);
  }
  const opp = other(m, uid);
  const nA = V.esc(V.nameOf(m, st, m.a));
  const nB = V.esc(V.nameOf(m, st, m.b));
  await i
    .followUp({
      content: `<@${opp}> 결과 확인 부탁해요! 📝 **${nA} ${sa} : ${sb} ${nB}** — ${V.ts(m.deadline)} 자동 확정`,
      allowedMentions: { users: [opp] },
    })
    .catch(() => {});
}

module.exports = { init, declareWar, handleButton, handleModal, rearm, _test: { onDeadline, timers, cooldowns } };
