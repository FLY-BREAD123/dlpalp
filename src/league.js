'use strict';
// ⚽ 리그 계산 — 순수 함수 (디스코드 의존성 없음 → 단독 테스트 가능)

const TITLES = [
  { min: 0, name: '🥚 피파 새싹' },
  { min: 1, name: '⚽ 동네 공차기' },
  { min: 5, name: '🥾 주말 리거' },
  { min: 10, name: '🔥 피파 전사' },
  { min: 20, name: '⚔️ 전쟁 영웅' },
  { min: 35, name: '🛡️ 피파 장군' },
  { min: 50, name: '👑 피파 황제' },
  { min: 100, name: '🌌 살아있는 전설' },
];
const STREAK_MILESTONES = [3, 5, 7, 10, 15, 20, 30, 50];
const SLUMP_MILESTONES = [3, 5, 7, 10];
const HISTORY_LIMIT = 300;
const FORM_LEN = 5;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function blankPlayer(id) {
  return { id, name: '', avatar: '', w: 0, d: 0, l: 0, gf: 0, ga: 0, streak: 0, best: 0, runs: 0, form: [], h2h: {}, last: 0 };
}

// 예전 records.json({win, lose}) 형식도 받아줌
function normalizePlayer(id, p = {}) {
  const out = blankPlayer(id);
  out.name = typeof p.name === 'string' ? p.name : '';
  out.avatar = typeof p.avatar === 'string' ? p.avatar : '';
  out.w = num(p.w ?? p.win ?? p.wins);
  out.d = num(p.d ?? p.draw ?? p.draws);
  out.l = num(p.l ?? p.lose ?? p.loss ?? p.losses);
  out.gf = num(p.gf);
  out.ga = num(p.ga);
  out.streak = num(p.streak);
  out.best = Math.max(num(p.best ?? p.bestStreak), out.streak, 0);
  out.runs = num(p.runs);
  out.form = Array.isArray(p.form) ? p.form.filter((r) => r === 'W' || r === 'D' || r === 'L').slice(0, FORM_LEN) : [];
  const src = p.h2h && typeof p.h2h === 'object' ? p.h2h : {};
  for (const [opp, r] of Object.entries(src)) {
    if (!r || typeof r !== 'object') continue;
    out.h2h[opp] = { w: num(r.w ?? r.win), d: num(r.d ?? r.draw), l: num(r.l ?? r.lose), gf: num(r.gf), ga: num(r.ga) };
  }
  out.last = num(p.last);
  return out;
}

const validMatch = (m) => m && m.a && m.b && Number.isFinite(m.sa) && Number.isFinite(m.sb);

function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const settings = s.settings && typeof s.settings === 'object' ? s.settings : {};
  const state = {
    version: 2,
    savedAt: num(s.savedAt),
    settings: {
      alertChannelId: String(settings.alertChannelId || ''),
      alertRoleId: String(settings.alertRoleId || ''),
    },
    players: {},
    matches: Array.isArray(s.matches) ? s.matches.filter(validMatch).slice(0, HISTORY_LIMIT) : [],
    active: {},
  };
  const players =
    s.players && typeof s.players === 'object' ? s.players : s.records && typeof s.records === 'object' ? s.records : s;
  for (const [id, p] of Object.entries(players)) {
    if (/^\d{15,22}$/.test(id) && p && typeof p === 'object') state.players[id] = normalizePlayer(id, p);
  }
  if (s.active && typeof s.active === 'object') {
    for (const [id, m] of Object.entries(s.active)) {
      if (m && m.a && m.b && m.status && m.deadline) state.active[id] = m;
    }
  }
  return state;
}

function ensurePlayer(state, id, info) {
  let p = state.players[id];
  if (!p) p = state.players[id] = blankPlayer(id);
  if (info) {
    if (info.name) p.name = String(info.name).slice(0, 64);
    if (info.avatar) p.avatar = String(info.avatar);
  }
  return p;
}

// 이름/아바타 갱신 — 바뀌었으면 true
function refreshInfo(state, id, info) {
  const p = state.players[id];
  if (!p || !info) return false;
  const name = info.name ? String(info.name).slice(0, 64) : p.name;
  const avatar = info.avatar ? String(info.avatar) : p.avatar;
  if (name === p.name && avatar === p.avatar) return false;
  p.name = name;
  p.avatar = avatar;
  return true;
}

function stats(p) {
  const played = p.w + p.d + p.l;
  return { played, pts: p.w * 3 + p.d, gd: p.gf - p.ga, rate: played ? Math.round((p.w / played) * 100) : 0 };
}

// 승점 → 득실차 → 다득점 → 다승 → 적은 경기 → 이름
function compare(a, b) {
  const sa = stats(a);
  const sb = stats(b);
  return (
    sb.pts - sa.pts ||
    sb.gd - sa.gd ||
    b.gf - a.gf ||
    b.w - a.w ||
    sa.played - sb.played ||
    (a.name || '').localeCompare(b.name || '', 'ko')
  );
}

function table(state) {
  return Object.values(state.players)
    .filter((p) => stats(p).played > 0)
    .sort(compare);
}

function rankOf(state, id) {
  const i = table(state).findIndex((p) => p.id === id);
  return i < 0 ? null : i + 1;
}

function titleFor(wins) {
  let t = TITLES[0];
  for (const x of TITLES) if (wins >= x.min) t = x;
  return t;
}

function nextTitle(wins) {
  return TITLES.find((x) => x.min > wins) || null;
}

function record(p, oppId, gf, ga, res, at) {
  if (res === 'W') {
    p.w++;
    p.streak = p.streak > 0 ? p.streak + 1 : 1;
  } else if (res === 'L') {
    p.l++;
    p.streak = p.streak < 0 ? p.streak - 1 : -1;
  } else {
    p.d++;
    p.streak = 0;
  }
  p.best = Math.max(p.best, p.streak);
  p.gf += gf;
  p.ga += ga;
  p.form.unshift(res);
  if (p.form.length > FORM_LEN) p.form.length = FORM_LEN;
  const h = p.h2h[oppId] || (p.h2h[oppId] = { w: 0, d: 0, l: 0, gf: 0, ga: 0 });
  if (res === 'W') h.w++;
  else if (res === 'L') h.l++;
  else h.d++;
  h.gf += gf;
  h.ga += ga;
  p.last = at;
}

/**
 * 경기 결과 반영
 * r = { id, a, b, sa, sb, at, infoA, infoB }   (a = 선포자, b = 도전받은 사람)
 * → { outcome: 'A'|'B'|'D', winner, loser, A, B, events[] }
 */
function applyResult(state, r) {
  const A = ensurePlayer(state, r.a, r.infoA);
  const B = ensurePlayer(state, r.b, r.infoB);
  const prev = {
    aStreak: A.streak,
    bStreak: B.streak,
    aTitle: titleFor(A.w).name,
    bTitle: titleFor(B.w).name,
    leader: table(state)[0]?.id || null,
  };
  const outcome = r.sa > r.sb ? 'A' : r.sa < r.sb ? 'B' : 'D';
  record(A, B.id, r.sa, r.sb, outcome === 'A' ? 'W' : outcome === 'B' ? 'L' : 'D', r.at);
  record(B, A.id, r.sb, r.sa, outcome === 'B' ? 'W' : outcome === 'A' ? 'L' : 'D', r.at);
  state.matches.unshift({ id: r.id, a: r.a, b: r.b, sa: r.sa, sb: r.sb, at: r.at });
  if (state.matches.length > HISTORY_LIMIT) state.matches.length = HISTORY_LIMIT;

  const events = [];
  const winner = outcome === 'A' ? A : outcome === 'B' ? B : null;
  const loser = outcome === 'A' ? B : outcome === 'B' ? A : null;
  if (winner) {
    if (STREAK_MILESTONES.includes(winner.streak)) events.push({ type: 'streak', id: winner.id, n: winner.streak });
    const loserPrev = loser === A ? prev.aStreak : prev.bStreak;
    if (loserPrev >= 3) events.push({ type: 'breaker', id: winner.id, victim: loser.id, n: loserPrev });
    const nowTitle = titleFor(winner.w).name;
    if (nowTitle !== (winner === A ? prev.aTitle : prev.bTitle)) events.push({ type: 'title', id: winner.id, title: nowTitle });
    if (SLUMP_MILESTONES.includes(-loser.streak)) events.push({ type: 'slump', id: loser.id, n: -loser.streak });
  } else {
    if (prev.aStreak >= 3) events.push({ type: 'stopped', id: A.id, by: B.id, n: prev.aStreak });
    if (prev.bStreak >= 3) events.push({ type: 'stopped', id: B.id, by: A.id, n: prev.bStreak });
  }
  const leader = table(state)[0]?.id || null;
  if (leader && leader !== prev.leader && (leader === A.id || leader === B.id)) events.push({ type: 'leader', id: leader });

  return { outcome, winner, loser, A, B, events };
}

const ZERO = Object.freeze({ w: 0, d: 0, l: 0, gf: 0, ga: 0 });

function h2hOf(state, a, b) {
  return state.players[a]?.h2h?.[b] || ZERO;
}

// a 기준으로 방향을 맞춘 최근 맞대결
function meetings(state, a, b, n = 5) {
  return state.matches
    .filter((m) => (m.a === a && m.b === b) || (m.a === b && m.b === a))
    .slice(0, n)
    .map((m) => (m.a === a ? m : { ...m, a: m.b, b: m.a, sa: m.sb, sb: m.sa }));
}

// 천적(나한테 강한 상대) / 먹잇감(내가 강한 상대)
function rivals(p) {
  let nemesis = null;
  let victim = null;
  for (const [id, h] of Object.entries(p.h2h || {})) {
    if (h.l > 0 && h.l >= h.w && (!nemesis || h.l > nemesis.h.l || (h.l === nemesis.h.l && h.w < nemesis.h.w))) {
      nemesis = { id, h };
    }
    if (h.w > 0 && h.w >= h.l && (!victim || h.w > victim.h.w || (h.w === victim.h.w && h.l < victim.h.l))) {
      victim = { id, h };
    }
  }
  if (nemesis && victim && nemesis.id === victim.id) {
    // 완전 동률 상대 → 천적/먹잇감 둘 다 표시하지 않음
    if (nemesis.h.w === nemesis.h.l) return { nemesis: null, victim: null };
  }
  return { nemesis, victim };
}

module.exports = {
  TITLES,
  HISTORY_LIMIT,
  blankPlayer,
  normalizePlayer,
  normalizeState,
  ensurePlayer,
  refreshInfo,
  stats,
  table,
  rankOf,
  titleFor,
  nextTitle,
  applyResult,
  h2hOf,
  meetings,
  rivals,
};
