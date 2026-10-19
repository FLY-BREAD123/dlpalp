'use strict';
// 🎨 임베드 · 버튼 · 모달 — 화면에 보이는 건 전부 여기

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} = require('discord.js');
const cfg = require('./config');
const L = require('./league');

const C = cfg.COLORS;

// ───────── 헬퍼 ─────────
const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
const msgUrl = (g, c, m) => `https://discord.com/channels/${g}/${c}/${m}`;
const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const esc = (s) => escapeMarkdown(String(s ?? ''));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : undefined);
const alertUrl = (m) => (m.alert ? msgUrl(m.guildId, m.alert.channelId, m.alert.messageId) : null);
const nameOf = (m, st, id) => m?.names?.[id] || st?.players?.[id]?.name || '???';

function infoOf(user, member) {
  const name = member?.displayName || member?.nick || user?.globalName || user?.username || '???';
  let avatar = '';
  try {
    avatar =
      typeof member?.displayAvatarURL === 'function'
        ? member.displayAvatarURL({ size: 128, extension: 'png', forceStatic: true })
        : user.displayAvatarURL({ size: 128, extension: 'png', forceStatic: true });
  } catch {
    avatar = '';
  }
  return { name, avatar };
}

function streakText(p, min = 1) {
  if (!p) return '';
  if (p.streak >= min) return `🔥 ${p.streak}연승`;
  if (p.streak <= -min) return `🥶 ${-p.streak}연패`;
  return '';
}

function formText(p) {
  const s = [...(p?.form || [])]
    .reverse()
    .map((r) => (r === 'W' ? '🟩' : r === 'L' ? '🟥' : '⬜'))
    .join('');
  return s || '—';
}

function statusLabel(status) {
  return { pending: '응답 대기', playing: '경기 중', confirming: '결과 확인 중' }[status] || status;
}

// ───────── 대사 ─────────
const TAUNTS = [
  '오늘 밤, 한 명은 패배의 쓴맛을 본다... ⚽',
  '{B}, 도망치면 평생 놀림감 확정 🐔',
  '{A}가 장갑을 던졌다. 주울 것인가, 피할 것인가 🧤',
  'VAR도 못 구해준다. 실력으로 증명해라 📺',
  '말보다 골로 증명하자 ⚽🔥',
  '패스 미스 하나가 운명을 가른다 🎯',
  '오늘 지는 사람은 하루 종일 조용히 지내기 😶',
  '{B}의 골키퍼, 오늘 야근 확정 🥅',
  '심판은 없다. 오직 스코어만 기억된다 📋',
  '킥오프 휘슬 직전... 긴장감 MAX ⚡',
];
const ROASTS = [
  '🐔 꼬꼬댁... 꽁무니를 뺐습니다',
  '🏳️ 백기 투항. 싸워보지도 않고 졌다',
  '💨 전속력으로 도망! 그 스피드면 윙어 해도 되겠는데?',
  '🫣 무서웠나 봐요... 다음엔 용기 내봐요',
  '🧻 패배가 두려워 화장실로 대피했습니다',
];
const SNOOZE = ['😴 자는 척하는 거 다 압니다', '📵 읽씹 당했습니다...', '🦗 귀뚤귀뚤... 아무 응답이 없었다'];

const taunt = (nameA, nameB) => fill(pick(TAUNTS), { A: esc(nameA), B: esc(nameB) });
const roast = () => pick(ROASTS);

function verdict(diff) {
  if (diff >= 4) return '💀 학살 수준... 정신 차리세요';
  if (diff === 3) return '🔥 압도적인 승리';
  if (diff === 2) return '💪 확실한 승리';
  return '😮‍💨 간발의 차 신승';
}

// ───────── 버튼 ─────────
const btn = (id, label, style) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const cid = (act, m) => `fw|${act}|${m.guildId}|${m.id}`;

function linkRow(url, label) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url));
}

function challengeRow(m, link) {
  const row = new ActionRowBuilder().addComponents(
    btn(cid('acc', m), '⚔️ 전쟁 수락', ButtonStyle.Success),
    btn(cid('run', m), '🏳️ 도망가기', ButtonStyle.Danger),
  );
  if (link) row.addComponents(new ButtonBuilder().setLabel('🚨 경보 보기').setStyle(ButtonStyle.Link).setURL(link));
  return row;
}

function matchRow(m) {
  if (m.status === 'confirming') {
    return new ActionRowBuilder().addComponents(
      btn(cid('ok', m), '✅ 확인', ButtonStyle.Success),
      btn(cid('obj', m), '⚠️ 이의제기', ButtonStyle.Danger),
      btn(cid('rep', m), '✏️ 다시 입력', ButtonStyle.Secondary),
    );
  }
  return new ActionRowBuilder().addComponents(
    btn(cid('rep', m), '📝 결과 입력', ButtonStyle.Primary),
    btn(cid('cxl', m), '❌ 경기 취소', ButtonStyle.Secondary),
  );
}

function reportModal(m, st) {
  const nA = clip(nameOf(m, st, m.a), 34);
  const nB = clip(nameOf(m, st, m.b), 34);
  const input = (id, val) => {
    const t = new TextInputBuilder()
      .setCustomId(id)
      .setStyle(TextInputStyle.Short)
      .setMinLength(1)
      .setMaxLength(2)
      .setPlaceholder('숫자만 (예: 3)')
      .setRequired(true);
    if (Number.isFinite(val)) t.setValue(String(val));
    return t;
  };
  return new ModalBuilder()
    .setCustomId(`fwm|${m.guildId}|${m.id}`)
    .setTitle('⚽ 경기 결과 입력')
    .addLabelComponents(
      new LabelBuilder().setLabel(`${nA} 득점`).setDescription('🔴 전쟁을 건 사람').setTextInputComponent(input('sa', m.report?.sa)),
      new LabelBuilder().setLabel(`${nB} 득점`).setDescription('🔵 전쟁을 받은 사람').setTextInputComponent(input('sb', m.report?.sb)),
    );
}

// ───────── 전쟁 메시지 ─────────
function brief(p) {
  if (!p || L.stats(p).played === 0) return `${L.titleFor(0).name}\n첫 전쟁!`;
  const s = L.stats(p);
  const st = streakText(p, 2);
  return `${L.titleFor(p.w).name}\n${p.w}승 ${p.d}무 ${p.l}패 · **${s.pts}점**${st ? `\n${st}` : ''}`;
}

function challengePayload(m, st) {
  const nA = nameOf(m, st, m.a);
  const nB = nameOf(m, st, m.b);
  const h = L.h2hOf(st, m.a, m.b);
  const met = h.w + h.d + h.l;
  const e = new EmbedBuilder()
    .setColor(C.alert)
    .setAuthor({ name: 'FIFA WAR · 전쟁 선포', iconURL: safeUrl(m.avatars?.[m.a]) })
    .setTitle('🚨 피파 전쟁 경보 🚨')
    .setDescription(
      [
        `<@${m.a}> 님이 <@${m.b}> 님에게 **축구 전쟁**을 걸었습니다! ⚔️`,
        '',
        `> ${m.taunt}`,
        '',
        `⏳ ${ts(m.deadline)} 까지 응답 없으면 전쟁 무산`,
      ].join('\n'),
    )
    .addFields(
      { name: `🔴 ${clip(nA, 40)}`, value: brief(st.players[m.a]), inline: true },
      { name: '⚔️', value: '**VS**', inline: true },
      { name: `🔵 ${clip(nB, 40)}`, value: brief(st.players[m.b]), inline: true },
    )
    .setFooter({
      text: m.dmBlocked ? '⚠️ 상대 DM이 막혀 있어요 — 이 메시지 버튼으로 응답' : '📩 상대에게 DM 전송 · 수락하면 킥오프!',
    })
    .setTimestamp(m.createdAt);
  if (met) e.addFields({ name: '📜 상대전적', value: `${esc(clip(nA, 20))} **${h.w}승 ${h.d}무 ${h.l}패** ${esc(clip(nB, 20))}` });
  if (safeUrl(m.avatars?.[m.b])) e.setThumbnail(m.avatars[m.b]);
  return { embeds: [e], components: [challengeRow(m)] };
}

function dmChallengePayload(m, st, guildName) {
  const nA = nameOf(m, st, m.a);
  const nB = nameOf(m, st, m.b);
  const e = new EmbedBuilder()
    .setColor(C.alert)
    .setTitle('🚨 피파 전쟁 선포!')
    .setDescription(
      [
        `**${esc(nA)}**님이 **${esc(nB)}**님한테 축구 전쟁을 걸었습니다! ⚔️`,
        '',
        `📍 서버: **${esc(guildName)}**`,
        `⏳ ${ts(m.deadline)} 까지 응답`,
        '',
        `> ${m.taunt}`,
      ].join('\n'),
    )
    .setFooter({ text: '수락하면 킥오프! 도망가면... 서버에 소문납니다 🐔' })
    .setTimestamp(m.createdAt);
  if (safeUrl(m.avatars?.[m.a])) e.setThumbnail(m.avatars[m.a]);
  return { embeds: [e], components: [challengeRow(m, alertUrl(m))] };
}

function matchPayload(m, st) {
  const nA = nameOf(m, st, m.a);
  const nB = nameOf(m, st, m.b);
  const e = new EmbedBuilder().setTimestamp(m.acceptedAt || m.createdAt);
  let content;
  if (m.status === 'confirming' && m.report) {
    const r = m.report;
    const other = r.by === m.a ? m.b : m.a;
    e.setColor(C.gold)
      .setTitle('📝 결과 확인 대기')
      .setDescription(
        [
          `## ${esc(nA)}  ${r.sa} : ${r.sb}  ${esc(nB)}`,
          `제출: <@${r.by}>`,
          '',
          `<@${other}> 님, 맞으면 **✅ 확인** · 틀리면 **⚠️ 이의제기**`,
          `⏱️ ${ts(m.deadline)} 자동 확정`,
        ].join('\n'),
      )
      .setFooter({ text: `🔴 ${clip(nA, 30)}  vs  🔵 ${clip(nB, 30)}` });
    content = `📝 **결과 확인 대기** — <@${other}>`;
  } else {
    e.setColor(C.cyan)
      .setTitle('⚽ 킥오프! 전쟁 진행 중')
      .setDescription(
        [
          `🔴 <@${m.a}>  🆚  🔵 <@${m.b}>`,
          '',
          '경기 끝나면 **📝 결과 입력** → 스코어 입력',
          '상대가 **✅ 확인**하면 전적에 반영돼요',
          `⏳ 결과 입력 마감 ${ts(m.deadline)}`,
          m.note ? `\n${m.note}` : '',
        ].join('\n'),
      );
    content = `⚽ **전쟁 진행 중** — <@${m.a}> vs <@${m.b}>`;
  }
  return { content, embeds: [e], components: [matchRow(m)], allowedMentions: { parse: [] } };
}

function after(st, p) {
  const s = L.stats(p);
  const rank = L.rankOf(st, p.id);
  const sk = streakText(p, 2);
  return `${L.titleFor(p.w).name}\n${p.w}승 ${p.d}무 ${p.l}패 · **${s.pts}점** · ${rank}위${sk ? `\n${sk}` : ''}`;
}

function resultPayload(m, st, res, { auto = false } = {}) {
  const nA = nameOf(m, st, m.a);
  const nB = nameOf(m, st, m.b);
  const { sa, sb } = m.report;
  const lines = [`## ${esc(nA)}  ${sa} : ${sb}  ${esc(nB)}`];
  if (res.outcome === 'D') {
    lines.push('🤝 **무승부!** 승부는 다음 기회에');
  } else {
    const wn = res.outcome === 'A' ? nA : nB;
    lines.push(`🏆 **${esc(wn)}** 승리! ${verdict(Math.abs(sa - sb))}`);
    if ((res.outcome === 'A' ? sb : sa) === 0) lines.push('🧤 클린시트 달성');
  }
  const h = L.h2hOf(st, m.a, m.b);
  const e = new EmbedBuilder()
    .setColor(res.outcome === 'D' ? C.draw : C.win)
    .setTitle('🏁 경기 종료')
    .setDescription(lines.join('\n'))
    .addFields(
      { name: `🔴 ${clip(nA, 40)}`, value: after(st, res.A), inline: true },
      { name: `🔵 ${clip(nB, 40)}`, value: after(st, res.B), inline: true },
      { name: '📜 상대전적', value: `${esc(clip(nA, 20))} **${h.w}승 ${h.d}무 ${h.l}패** ${esc(clip(nB, 20))}` },
    )
    .setFooter({ text: auto ? '⏱️ 이의제기 없어 자동 확정' : '✅ 양측 확인 완료' })
    .setTimestamp();
  return { content: '🏁 **경기 종료**', embeds: [e], components: [], allowedMentions: { parse: [] } };
}

function dmResultPayload(m, st, res) {
  const nA = nameOf(m, st, m.a);
  const nB = nameOf(m, st, m.b);
  const { sa, sb } = m.report;
  const mine = res.outcome === 'B' ? '🏆 승리!' : res.outcome === 'A' ? '💀 패배...' : '🤝 무승부';
  const e = new EmbedBuilder()
    .setColor(res.outcome === 'B' ? C.win : res.outcome === 'A' ? C.alert : C.draw)
    .setTitle(`🏁 경기 종료 — ${mine}`)
    .setDescription(`**${esc(nA)}** ${sa} : ${sb} **${esc(nB)}**\n\n${after(st, res.B)}`);
  const url = alertUrl(m);
  return { embeds: [e], components: url ? [linkRow(url, '🏁 결과 보기')] : [] };
}

function closedPayload(m, st, kind, extra = {}) {
  const e = new EmbedBuilder().setColor(C.gray).setTimestamp();
  let content;
  if (kind === 'run') {
    e.setTitle('🏳️ 전쟁 회피').setDescription(
      `<@${m.b}> 님이 <@${m.a}> 님의 전쟁을 피했습니다...\n> ${extra.roast || roast()}\n\n🐔 도망 누적 **${extra.runs || 1}회**`,
    );
    content = '🏳️ **전쟁 회피**';
  } else if (kind === 'expire') {
    e.setTitle('⌛ 전쟁 무산').setDescription(`<@${m.b}> 님 응답 없음... ${pick(SNOOZE)}`);
    content = '⌛ **전쟁 무산**';
  } else if (kind === 'cancel') {
    e.setTitle('❌ 경기 취소').setDescription(`<@${extra.by}> 님이 경기를 취소했어요. 전적엔 반영되지 않아요.`);
    content = '❌ **경기 취소**';
  } else {
    e.setTitle('⌛ 경기 무효').setDescription(`<@${m.a}> vs <@${m.b}>\n결과가 입력되지 않아 무효 처리됐어요.`);
    content = '⌛ **경기 무효**';
  }
  return { content, embeds: [e], components: [], allowedMentions: { parse: [] } };
}

function dmNotePayload(m, title, desc, color = C.gray, label = '서버 메시지 보기') {
  const e = new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc);
  const url = alertUrl(m);
  return { embeds: [e], components: url ? [linkRow(url, label)] : [] };
}

function newsEmbed(events) {
  const lines = events
    .map((ev) => {
      switch (ev.type) {
        case 'streak':
          return `🔥 <@${ev.id}> 님 **${ev.n}연승** 질주 중!`;
        case 'breaker':
          return `💥 <@${ev.id}> 님이 <@${ev.victim}> 님의 **${ev.n}연승**을 끊었습니다!`;
        case 'stopped':
          return `🧱 <@${ev.by}> 님이 <@${ev.id}> 님의 **${ev.n}연승** 행진을 무승부로 멈춰 세웠습니다`;
        case 'title':
          return `🎖️ <@${ev.id}> 님 칭호 승급 → **${ev.title}**`;
        case 'slump':
          return `🥶 <@${ev.id}> 님 **${ev.n}연패**... 누가 좀 위로해줘요`;
        case 'leader':
          return `👑 <@${ev.id}> 님 리그 **1위** 등극!`;
        default:
          return '';
      }
    })
    .filter(Boolean);
  return new EmbedBuilder().setColor(C.gold).setTitle('📢 피파 속보').setDescription(lines.join('\n'));
}

// ───────── 조회 ─────────
function recordEmbed(st, id, info) {
  const p = st.players[id];
  const nm = info?.name || p?.name || '???';
  const avatar = safeUrl(info?.avatar || p?.avatar);
  const e = new EmbedBuilder().setColor(C.accent).setAuthor({ name: `${clip(nm, 60)}의 피파 전적`, iconURL: avatar });
  if (avatar) e.setThumbnail(avatar);
  if (!p || L.stats(p).played === 0) {
    return e
      .setTitle(L.titleFor(0).name)
      .setDescription(
        `아직 전쟁 기록이 없어요.\n\`/전쟁 상대:@친구\` 로 첫 전쟁을 선포해보세요! ⚔️${p?.runs ? `\n\n🐔 도망 ${p.runs}회` : ''}`,
      );
  }
  const s = L.stats(p);
  const rank = L.rankOf(st, id);
  const total = L.table(st).length;
  const next = L.nextTitle(p.w);
  const { nemesis, victim } = L.rivals(p);
  e.setTitle(L.titleFor(p.w).name)
    .setDescription(`**${rank}위** / ${total}명 · 승점 **${s.pts}** · ${s.played}경기`)
    .addFields(
      { name: '전적', value: `${p.w}승 ${p.d}무 ${p.l}패`, inline: true },
      { name: '승률', value: `${s.rate}%`, inline: true },
      { name: '득실', value: `${p.gf}득 ${p.ga}실 (${signed(s.gd)})`, inline: true },
      { name: '연속', value: streakText(p) || '—', inline: true },
      { name: '최고 연승', value: `${p.best}연승`, inline: true },
      { name: '도망', value: `🐔 ${p.runs}회`, inline: true },
      { name: '최근 5경기 (← 과거 · 최근 →)', value: formText(p) },
    );
  const rv = [];
  if (nemesis) rv.push(`😈 천적: <@${nemesis.id}> (${nemesis.h.w}승 ${nemesis.h.d}무 ${nemesis.h.l}패)`);
  if (victim) rv.push(`🍖 먹잇감: <@${victim.id}> (${victim.h.w}승 ${victim.h.d}무 ${victim.h.l}패)`);
  if (rv.length) e.addFields({ name: '🎯 천적 · 먹잇감', value: rv.join('\n') });
  if (next) e.setFooter({ text: `다음 칭호 ${next.name}까지 ${next.min - p.w}승` });
  return e;
}

function tableEmbed(st, guildName, viewerId) {
  const rows = L.table(st);
  const e = new EmbedBuilder()
    .setColor(C.accent)
    .setTitle('🏆 피파 리그 순위표')
    .setFooter({ text: '승 3점 · 무 1점 · 패 0점 → 승점, 득실차, 다득점 순' });
  if (guildName) e.setAuthor({ name: clip(guildName, 100) });
  if (!rows.length) return e.setDescription('아직 전쟁 기록이 없어요.\n`/전쟁 상대:@친구` 로 첫 전쟁을 선포해보세요! ⚔️');
  const medal = ['🥇', '🥈', '🥉'];
  const lines = rows.slice(0, 10).map((p, i) => {
    const s = L.stats(p);
    const fire = p.streak >= 3 ? ` 🔥${p.streak}` : '';
    const no = medal[i] || `\`${String(i + 1).padStart(2, ' ')}\``;
    return `${no} **${esc(clip(p.name || '???', 20))}**${fire} · **${s.pts}점** · ${p.w}승 ${p.d}무 ${p.l}패 · 득실 ${signed(s.gd)}`;
  });
  e.setDescription(lines.join('\n'));
  const mine = rows.findIndex((p) => p.id === viewerId);
  if (mine >= 10) {
    const p = rows[mine];
    const s = L.stats(p);
    e.addFields({ name: '내 순위', value: `**${mine + 1}위** · ${s.pts}점 · ${p.w}승 ${p.d}무 ${p.l}패` });
  }
  return e;
}

function h2hEmbed(st, a, b, nA, nB) {
  const h = L.h2hOf(st, a, b);
  const n = h.w + h.d + h.l;
  const e = new EmbedBuilder().setColor(C.cyan).setTitle(`📜 ${clip(nA, 30)} 🆚 ${clip(nB, 30)}`);
  if (!n) return e.setDescription('아직 맞대결 기록이 없어요. 붙어보세요! ⚔️');
  const lead = h.w > h.l ? `👑 **${esc(nA)}** 우세` : h.w < h.l ? `👑 **${esc(nB)}** 우세` : '⚖️ 호각';
  e.setDescription(`## ${h.w}승 ${h.d}무 ${h.l}패\n${lead} · 총 ${n}경기 · 득점 ${h.gf} : ${h.ga}`);
  const meets = L.meetings(st, a, b, 5).map(
    (m) => `${ts(m.at, 'd')}  ${esc(clip(nA, 16))} **${m.sa} : ${m.sb}** ${esc(clip(nB, 16))}`,
  );
  if (meets.length) e.addFields({ name: '최근 맞대결', value: meets.join('\n') });
  return e;
}

function helpEmbed(textEnabled) {
  return new EmbedBuilder()
    .setColor(C.accent)
    .setTitle('⚔️ 피파 전쟁 봇 사용법')
    .setDescription(
      [
        `**1. 전쟁 선포** — \`/전쟁 상대:@친구\`${textEnabled ? ' 또는 `@친구 피파전쟁`' : ''}`,
        '↳ 상대한테 DM + 경보 채널에 사이렌 🚨 → 수락하면 킥오프',
        '',
        '**2. 결과 입력** — 경기 끝나면 경보 메시지의 **📝 결과 입력** → 스코어 입력',
        '↳ 상대가 **✅ 확인** 누르면 확정 · 10분간 이의제기 없으면 자동 확정',
        '',
        `**3. 기록** — \`/전적\` \`/상대전적\` \`/랭킹\`${textEnabled ? '\n↳ 텍스트: `피파전적` `@친구 상대전적` `피파랭킹`' : ''}`,
        '',
        '🏅 승 3점 · 무 1점 · 패 0점 — 승점 → 득실차 → 다득점 순',
        '🔥 연승 속보 · 🐔 도망 횟수도 기록됩니다',
        '⚙️ `/피파설정` — 경보 채널·역할 (관리자)',
      ].join('\n'),
    )
    .addFields({ name: '🎖️ 칭호 (누적 승리)', value: L.TITLES.map((t) => `${t.name} ${t.min}승`).join(' · ') });
}

function settingsEmbed(st, info, { textEnabled, changed = false, warnings = [] }) {
  const s = st.settings;
  const alertCh = s.alertChannelId
    ? `<#${s.alertChannelId}>`
    : cfg.ALERT_CHANNEL_ID
      ? `<#${cfg.ALERT_CHANNEL_ID}> (환경변수)`
      : '명령어 쓴 채널';
  const alertRole = s.alertRoleId
    ? `<@&${s.alertRoleId}>`
    : cfg.ALERT_ROLE_ID
      ? `<@&${cfg.ALERT_ROLE_ID}> (환경변수)`
      : '없음 (상대만 핑)';
  const storage =
    info.mode === 'discord'
      ? `<#${info.channelId}> 채널에 자동 백업${info.lastSavedAt ? ` · 마지막 저장 ${ts(info.lastSavedAt)}` : ''}${
          info.lastError ? `\n⚠️ 최근 저장 오류: ${clip(info.lastError, 120)}` : ''
        }`
      : '⚠️ 백업 채널 없음 → Render 재시작 시 전적 초기화 위험\n봇에 **채널 관리** 권한 주고 재시작하거나 `DATA_CHANNEL_ID` 설정';
  const e = new EmbedBuilder()
    .setColor(changed ? C.win : C.accent)
    .setTitle(changed ? '✅ 설정 저장됨' : '⚙️ 피파 전쟁 설정')
    .addFields(
      { name: '🚨 경보 채널', value: alertCh, inline: true },
      { name: '📣 경보 역할', value: alertRole, inline: true },
      {
        name: '💬 텍스트 명령',
        value: textEnabled ? 'ON (`@친구 피파전쟁`)' : 'OFF — 포털에서 MESSAGE CONTENT INTENT 켜고 재시작하면 ON',
      },
      { name: '💾 전적 저장소', value: storage },
    );
  if (warnings.length) e.addFields({ name: '⚠️ 확인 필요', value: warnings.join('\n') });
  return e;
}

module.exports = {
  ts,
  msgUrl,
  clip,
  esc,
  alertUrl,
  nameOf,
  infoOf,
  statusLabel,
  taunt,
  roast,
  linkRow,
  reportModal,
  challengePayload,
  dmChallengePayload,
  matchPayload,
  resultPayload,
  dmResultPayload,
  closedPayload,
  dmNotePayload,
  newsEmbed,
  recordEmbed,
  tableEmbed,
  h2hEmbed,
  helpEmbed,
  settingsEmbed,
};
