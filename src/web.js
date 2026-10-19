'use strict';
// 🌐 웹서버 — Render 무료 웹서비스는 포트를 열어야 배포되고, 15분 무트래픽이면 잠듦
//    → 흑백 순위표 페이지(board.html) + /api/board + /health + 10분 간격 셀프핑

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const cfg = require('./config');
const L = require('./league');

const TEMPLATE = fs.readFileSync(path.join(__dirname, 'board.html'), 'utf8');
const FAVICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#000"/>' +
  '<rect x="14" y="12" width="16" height="40" rx="4" fill="#fff"/><rect x="34" y="12" width="16" height="40" rx="4" fill="#fff"/>' +
  '<rect x="10" y="31" width="44" height="2" fill="#000"/></svg>';

const avatarOk = (u) => typeof u === 'string' && /^https:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(u);
const key = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
const plainTitle = (t) => String(t).replace(/^[^\p{L}\p{N}]+/u, ''); // 웹은 흑백이라 칭호 이모지 제거

function health(runtime) {
  const c = runtime.client;
  const ready = !!c?.isReady?.();
  return {
    ok: true,
    bot: ready ? 'online' : runtime.status,
    tag: ready ? c.user.tag : null,
    ping: ready && c.ws.ping >= 0 ? Math.round(c.ws.ping) : null,
    guilds: ready ? c.guilds.cache.size : 0,
    textCommands: runtime.textEnabled,
    uptimeSec: Math.round(process.uptime()),
    error: ready ? null : runtime.error || null,
  };
}

function boards(runtime, store) {
  const c = runtime.client;
  const ready = !!c?.isReady?.();
  return store
    .entries()
    .map(([gid, st]) => {
      const g = ready ? c.guilds.cache.get(gid) : null;
      if (ready && !g) return null; // 나간 서버
      const nm = (id, m) => st.players[id]?.name || m?.names?.[id] || '???';
      const table = L.table(st);
      return {
        key: key(gid),
        name: g?.name || '피파 리그',
        rows: table.slice(0, 30).map((p, i) => {
          const s = L.stats(p);
          return {
            key: key(p.id),
            rank: i + 1,
            name: p.name || '???',
            avatar: avatarOk(p.avatar) ? p.avatar : '',
            title: plainTitle(L.titleFor(p.w).name),
            played: s.played,
            w: p.w,
            d: p.d,
            l: p.l,
            gf: p.gf,
            ga: p.ga,
            gd: s.gd,
            pts: s.pts,
            streak: p.streak,
            form: [...p.form].reverse(), // 과거 → 최근
          };
        }),
        recent: st.matches.slice(0, 10).map((m) => ({
          key: key(m.id || `${m.a}:${m.b}:${m.at}`),
          a: nm(m.a),
          b: nm(m.b),
          sa: m.sa,
          sb: m.sb,
          at: m.at,
        })),
        live: Object.values(st.active).map((m) => ({
          key: key(m.id),
          a: nm(m.a, m),
          b: nm(m.b, m),
          status: m.status,
          score: m.report ? `${m.report.sa} : ${m.report.sb}` : null,
        })),
        totals: { players: table.length, matches: table.reduce((n, p) => n + L.stats(p).played, 0) / 2 },
      };
    })
    .filter(Boolean);
}

function payload(runtime, store) {
  return {
    ...health(runtime),
    public: cfg.BOARD_PUBLIC,
    now: Date.now(),
    boards: cfg.BOARD_PUBLIC ? boards(runtime, store) : [],
  };
}

// <script type="application/json"> 안에 안전하게 넣기
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const scriptJson = (data) =>
  JSON.stringify(data).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');

function page(runtime, store) {
  const json = scriptJson(payload(runtime, store));
  return TEMPLATE.replace('__FW_DATA__', () => json);
}

// ───────── 서버 ─────────
function send(res, code, type, body, cache = 'no-store') {
  res.writeHead(code, { 'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff' });
  res.end(body);
}

function start({ runtime, store }) {
  const server = http.createServer((req, res) => {
    try {
      const p = new URL(req.url, 'http://local').pathname;
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', '');
      if (p === '/health' || p === '/healthz') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(health(runtime)));
      if (p === '/api/board') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(payload(runtime, store)));
      if (p === '/favicon.svg' || p === '/favicon.ico') return send(res, 200, 'image/svg+xml', FAVICON, 'public, max-age=86400');
      if (p === '/' || p === '/index.html') {
        return send(res, 200, 'text/html; charset=utf-8', req.method === 'HEAD' ? undefined : page(runtime, store));
      }
      send(res, 404, 'text/plain; charset=utf-8', '404');
    } catch (err) {
      console.error('[web] 오류:', err);
      if (!res.headersSent) res.writeHead(500);
      res.end('error');
    }
  });
  server.listen(cfg.PORT, '0.0.0.0', () => {
    console.log(`[web] 포트 ${cfg.PORT} 열림${cfg.PUBLIC_URL ? ` · ${cfg.PUBLIC_URL}` : ''}`);
  });

  // 셀프핑 — Render 무료 플랜 잠들기 방지
  if (cfg.PUBLIC_URL) {
    const target = `${cfg.PUBLIC_URL}/health`;
    setInterval(() => {
      fetch(target, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'fifa-war-keepalive' } }).catch((err) =>
        console.warn('[web] 셀프핑 실패:', err.message),
      );
    }, cfg.TIMING.keepAliveMs);
    console.log(`[web] 셀프핑 ON — ${cfg.TIMING.keepAliveMs / 60000}분마다 ${target}`);
  }
  return server;
}

module.exports = { start, page, payload, boards, health };
