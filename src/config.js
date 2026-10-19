'use strict';
// ⚙️ 설정 — Render 대시보드 환경변수(또는 로컬 .env)에서 읽음

const fs = require('fs');
const path = require('path');

// 로컬 실행용 .env 로더 (Render에선 대시보드 환경변수를 씀)
(function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(file);
      return;
    }
  } catch { /* 아래 수동 파서로 */ }
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
})();

const env = (key, def = '') => String(process.env[key] ?? def).trim();
const bool = (key, def) => {
  const v = env(key).toLowerCase();
  if (!v) return def;
  return ['1', 'true', 'yes', 'on', 'y'].includes(v);
};

// 토큰 붙여넣기 실수(따옴표, "Bot " 접두사, 공백) 자동 정리
const TOKEN = env('DISCORD_TOKEN')
  .replace(/^["'`]+|["'`]+$/g, '')
  .replace(/^Bot\s+/i, '')
  .replace(/\s+/g, '');

module.exports = {
  TOKEN,
  PORT: Number(env('PORT', '3000')) || 3000,
  // Render가 자동으로 넣어주는 공개 주소 → 셀프핑으로 잠들기 방지
  PUBLIC_URL: (env('KEEPALIVE_URL') || env('RENDER_EXTERNAL_URL')).replace(/\/+$/, ''),
  ON_RENDER: env('RENDER') === 'true',

  ALERT_CHANNEL_ID: env('ALERT_CHANNEL_ID'),
  ALERT_ROLE_ID: env('ALERT_ROLE_ID'),
  DATA_CHANNEL_ID: env('DATA_CHANNEL_ID'),
  DATA_CHANNEL_NAME: env('DATA_CHANNEL_NAME', 'fifa-war-db'),

  BOARD_PUBLIC: bool('BOARD_PUBLIC', true), // 웹 순위표 공개 여부
  TEXT_COMMANDS: bool('TEXT_COMMANDS', true), // "@상대 피파전쟁" 텍스트 명령 (MESSAGE CONTENT INTENT 필요)

  TZ: 'Asia/Seoul',

  TIMING: {
    challengeMs: 5 * 60 * 1000, // 선포 후 응답 대기
    matchMs: 3 * 60 * 60 * 1000, // 수락 후 결과 입력 마감
    confirmMs: 10 * 60 * 1000, // 결과 제출 후 상대 확인 대기 → 지나면 자동 확정
    disputeGraceMs: 30 * 60 * 1000, // 이의제기 후 최소 재입력 시간
    cooldownMs: 20 * 1000, // 선포 도배 방지
    saveDebounceMs: 3000,
    keepAliveMs: 10 * 60 * 1000, // 15분 무트래픽이면 Render가 재움 → 10분마다 핑
  },

  COLORS: {
    alert: 0xff4d6d,
    accent: 0xb478ff,
    cyan: 0x4de8ff,
    win: 0x3ddc97,
    draw: 0x9a94a8,
    gray: 0x4a4458,
    gold: 0xffc94d,
  },
};
