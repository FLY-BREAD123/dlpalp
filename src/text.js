'use strict';
// 💬 텍스트 명령 — "@상대 피파전쟁" 같은 예전 방식
// Developer Portal에서 MESSAGE CONTENT INTENT 를 켜야 동작 (꺼져 있으면 봇이 자동으로 슬래시 전용 모드로 뜸)

const L = require('./league');
const V = require('./views');
const war = require('./war');

let store = null;
let runtime = null;

function init(deps) {
  store = deps.store;
  runtime = deps.runtime;
}

const QUIET = { parse: [], repliedUser: false };

async function handle(message) {
  if (!message.inGuild() || message.author.bot || !message.content || message.content.length > 300) return;

  // 멘션·공백 제거한 본문으로 판정
  const bare = message.content.replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, ' ').replace(/\s+/g, '');
  if (!bare) return;
  const me = message.client.user.id;
  const target = message.mentions.users.find((u) => u.id !== me && u.id !== message.author.id) || null;
  const targetMember = target ? message.mentions.members?.get(target.id) || null : null;
  const reply = (payload) => message.reply({ allowedMentions: QUIET, ...payload }).catch(() => {});

  // ⚔️ 전쟁 선포
  if (bare.includes('피파전쟁')) {
    if (!target) {
      if (bare === '피파전쟁' || bare === '!피파전쟁') return reply({ content: '⚔️ 상대를 멘션해주세요! 예: `@친구 피파전쟁`' });
      return;
    }
    return war.declareWar({
      kind: 'text',
      message,
      guild: message.guild,
      channel: message.channel,
      a: { user: message.author, member: message.member },
      b: { user: target, member: targetMember },
    });
  }

  // 📜 상대전적
  if (bare === '상대전적' || bare === '!상대전적') {
    if (!target) return reply({ content: '📜 상대를 멘션해주세요! 예: `@친구 상대전적`' });
    const st = await store.ensure(message.guildId);
    const nA = V.infoOf(message.author, message.member).name;
    const nB = V.infoOf(target, targetMember).name;
    return reply({ embeds: [V.h2hEmbed(st, message.author.id, target.id, nA, nB)] });
  }

  // ⚽ 전적
  if (['피파전적', '!피파전적', '!전적'].includes(bare)) {
    const user = target || message.author;
    const member = target ? targetMember : message.member;
    const st = await store.ensure(message.guildId);
    const info = V.infoOf(user, member);
    if (L.refreshInfo(st, user.id, info)) store.touch(message.guildId);
    return reply({ embeds: [V.recordEmbed(st, user.id, info)] });
  }

  // 🏆 랭킹
  if (['피파랭킹', '!피파랭킹', '!랭킹'].includes(bare)) {
    const st = await store.ensure(message.guildId);
    return reply({ embeds: [V.tableEmbed(st, message.guild.name, message.author.id)] });
  }

  // ❓ 도움말
  if (['피파도움말', '!피파', '!피파도움말'].includes(bare)) {
    return reply({ embeds: [V.helpEmbed(runtime?.textEnabled ?? true)] });
  }
}

module.exports = { init, handle };
