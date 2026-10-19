'use strict';
// 🧭 슬래시 명령 — 서버별 등록이라 배포 즉시 반영됨

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const cfg = require('./config');
const L = require('./league');
const V = require('./views');
const war = require('./war');

const EPH = MessageFlags.Ephemeral;
const NONE = { parse: [] };

let store = null;
let runtime = null;

function init(deps) {
  store = deps.store;
  runtime = deps.runtime;
}

const defs = [
  new SlashCommandBuilder()
    .setName('전쟁')
    .setDescription('상대에게 피파 전쟁을 선포합니다 ⚔️ (DM + 경보)')
    .addUserOption((o) => o.setName('상대').setDescription('전쟁을 걸 상대').setRequired(true)),
  new SlashCommandBuilder()
    .setName('전적')
    .setDescription('피파 전적 카드 — 칭호, 순위, 연승, 천적')
    .addUserOption((o) => o.setName('유저').setDescription('볼 사람 (비우면 나)')),
  new SlashCommandBuilder()
    .setName('상대전적')
    .setDescription('두 사람의 맞대결 기록')
    .addUserOption((o) => o.setName('상대').setDescription('상대').setRequired(true))
    .addUserOption((o) => o.setName('유저').setDescription('기준 유저 (비우면 나)')),
  new SlashCommandBuilder().setName('랭킹').setDescription('피파 리그 순위표 🏆'),
  new SlashCommandBuilder().setName('도움말').setDescription('피파 전쟁 봇 사용법'),
  new SlashCommandBuilder()
    .setName('피파설정')
    .setDescription('경보 채널·역할 설정 (관리자)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) =>
      o
        .setName('경보채널')
        .setDescription('전쟁 경보가 울릴 채널')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .addRoleOption((o) => o.setName('경보역할').setDescription('경보 때 같이 핑할 역할'))
    .addBooleanOption((o) => o.setName('역할핑끄기').setDescription('경보 역할 핑 해제')),
];
const JSON_DEFS = defs.map((d) => d.toJSON());

async function register(guild) {
  try {
    await guild.commands.set(JSON_DEFS);
    console.log(`[cmd] ${guild.name}: 슬래시 명령 ${JSON_DEFS.length}개 등록`);
  } catch (err) {
    console.warn(
      `[cmd] ${guild.name}: 명령 등록 실패 (${err.message}) — 초대 링크에 applications.commands 스코프가 있었는지 확인`,
    );
  }
}

function memberOf(i, name, user) {
  return i.options.getMember(name) || (user?.id === i.user.id ? i.member : null);
}

async function handle(i) {
  if (!i.inGuild() || !i.guild) {
    return i.reply({ content: '서버 안에서만 쓸 수 있어요.', flags: EPH });
  }

  switch (i.commandName) {
    case '전쟁': {
      await i.deferReply({ flags: EPH });
      const target = i.options.getUser('상대');
      return war.declareWar({
        kind: 'slash',
        interaction: i,
        guild: i.guild,
        channel: i.channel,
        a: { user: i.user, member: i.member },
        b: { user: target, member: i.options.getMember('상대') },
      });
    }

    case '전적': {
      const user = i.options.getUser('유저') || i.user;
      const st = await store.ensure(i.guildId);
      const info = V.infoOf(user, memberOf(i, '유저', user));
      if (L.refreshInfo(st, user.id, info)) store.touch(i.guildId);
      return i.reply({ embeds: [V.recordEmbed(st, user.id, info)], allowedMentions: NONE });
    }

    case '상대전적': {
      const opp = i.options.getUser('상대');
      const base = i.options.getUser('유저') || i.user;
      if (opp.id === base.id) return i.reply({ content: '😅 같은 사람끼리는 상대전적이 없어요.', flags: EPH });
      const st = await store.ensure(i.guildId);
      const nA = V.infoOf(base, memberOf(i, '유저', base)).name;
      const nB = V.infoOf(opp, i.options.getMember('상대')).name;
      return i.reply({ embeds: [V.h2hEmbed(st, base.id, opp.id, nA, nB)], allowedMentions: NONE });
    }

    case '랭킹': {
      const st = await store.ensure(i.guildId);
      const components = cfg.BOARD_PUBLIC && cfg.PUBLIC_URL ? [V.linkRow(cfg.PUBLIC_URL, '🌐 웹 순위표')] : [];
      return i.reply({ embeds: [V.tableEmbed(st, i.guild.name, i.user.id)], components, allowedMentions: NONE });
    }

    case '도움말':
      return i.reply({ embeds: [V.helpEmbed(runtime.textEnabled)], allowedMentions: NONE });

    case '피파설정':
      return settings(i);

    default:
      return i.reply({ content: '알 수 없는 명령이에요.', flags: EPH });
  }
}

async function settings(i) {
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return i.reply({ content: '🔒 서버 관리 권한이 필요해요.', flags: EPH });
  }
  const st = await store.ensure(i.guildId);
  const ch = i.options.getChannel('경보채널');
  const role = i.options.getRole('경보역할');
  const clearRole = i.options.getBoolean('역할핑끄기');
  let changed = false;
  if (ch) {
    st.settings.alertChannelId = ch.id;
    changed = true;
  }
  if (clearRole) {
    st.settings.alertRoleId = '';
    changed = true;
  } else if (role) {
    st.settings.alertRoleId = role.id;
    changed = true;
  }
  if (changed) {
    store.touch(i.guildId);
    await store.flush(i.guildId).catch(() => {});
  }

  // 권한 점검
  const warnings = [];
  const me = i.guild.members.me;
  const alertId = st.settings.alertChannelId || cfg.ALERT_CHANNEL_ID;
  const alertCh = alertId ? i.guild.channels.cache.get(alertId) : null;
  if (alertCh && me) {
    const perms = alertCh.permissionsFor(me);
    const need = [
      [PermissionFlagsBits.ViewChannel, '채널 보기'],
      [PermissionFlagsBits.SendMessages, '메시지 보내기'],
      [PermissionFlagsBits.EmbedLinks, '링크 첨부'],
    ].filter(([bit]) => !perms?.has(bit));
    if (need.length) warnings.push(`봇이 <#${alertCh.id}> 에서 **${need.map((n) => n[1]).join(', ')}** 권한이 없어요.`);
  }
  const roleId = st.settings.alertRoleId || cfg.ALERT_ROLE_ID;
  const roleObj = roleId ? i.guild.roles.cache.get(roleId) : null;
  if (roleObj && !roleObj.mentionable && !me?.permissions.has(PermissionFlagsBits.MentionEveryone)) {
    warnings.push(`<@&${roleObj.id}> 역할이 멘션 불가 상태예요 → 역할 설정에서 "멘션 허용" 켜거나 봇에 @everyone 멘션 권한 주기`);
  }

  return i.reply({
    embeds: [V.settingsEmbed(st, store.info(i.guildId), { textEnabled: runtime.textEnabled, changed, warnings })],
    flags: EPH,
    allowedMentions: NONE,
  });
}

module.exports = { init, register, handle, JSON_DEFS };
