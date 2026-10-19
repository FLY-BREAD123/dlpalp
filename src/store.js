'use strict';
// 💾 저장소 — Render 무료 플랜은 디스크가 휘발성이라, 서버 안 숨김 채널(#fifa-war-db)에
//    JSON 파일로 백업하고 부팅 때 다시 읽어옴. 외부 DB 가입 필요 없음.

const fs = require('fs');
const path = require('path');
const { ChannelType, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const cfg = require('./config');
const { normalizeState } = require('./league');

const FILE_NAME = 'fifa-war-db.json';
const KEEP = 5; // 백업 메시지 최근 5개 보관
const LOCAL_DIR = path.join(__dirname, '..', 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Store {
  constructor(getClient) {
    this.getClient = getClient;
    this.g = new Map(); // guildId -> entry
  }

  _entry(gid) {
    let e = this.g.get(gid);
    if (!e) {
      e = { state: null, loading: null, channelId: '', channelName: '', timer: null, saving: null, again: false, noPrune: false, lastSavedAt: 0, lastError: '' };
      this.g.set(gid, e);
    }
    return e;
  }

  ensure(gid) {
    const e = this._entry(gid);
    if (e.state) return Promise.resolve(e.state);
    if (!e.loading) {
      e.loading = this._load(gid, e)
        .catch((err) => {
          console.error('[store] 로드 실패 → 빈 데이터로 시작:', err);
          e.noPrune = true;
          return normalizeState(null);
        })
        .then((s) => {
          e.state = s;
          return s;
        })
        .finally(() => {
          e.loading = null;
        });
    }
    return e.loading;
  }

  peek(gid) {
    return this.g.get(gid)?.state || null;
  }

  entries() {
    return [...this.g].filter(([, e]) => e.state).map(([id, e]) => [id, e.state]);
  }

  info(gid) {
    const e = this.g.get(gid);
    return {
      mode: e?.channelId ? 'discord' : 'local',
      channelId: e?.channelId || '',
      channelName: e?.channelName || '',
      lastSavedAt: e?.lastSavedAt || 0,
      lastError: e?.lastError || '',
    };
  }

  // 변경 표시 → 3초 모아서 저장
  touch(gid) {
    const e = this.g.get(gid);
    if (!e?.state) return;
    clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      this.flush(gid).catch((err) => console.error('[store] 저장 오류:', err));
    }, cfg.TIMING.saveDebounceMs);
  }

  flush(gid) {
    const e = this.g.get(gid);
    if (!e?.state) return Promise.resolve();
    clearTimeout(e.timer);
    e.timer = null;
    if (e.saving) {
      e.again = true;
      return e.saving;
    }
    e.saving = (async () => {
      do {
        e.again = false;
        e.state.savedAt = Date.now();
        const json = JSON.stringify(e.state);
        this._writeLocal(gid, json);
        await this._writeDiscord(gid, e, json);
      } while (e.again);
    })().finally(() => {
      e.saving = null;
    });
    return e.saving;
  }

  async flushAll() {
    await Promise.allSettled([...this.g.keys()].map((gid) => this.flush(gid)));
  }

  // ───────── 로드 ─────────
  async _load(gid, e) {
    let fromDiscord = null;
    const client = this.getClient();
    const guild = client ? await client.guilds.fetch(gid).catch(() => null) : null;
    if (guild) {
      const ch = await this._resolveChannel(guild);
      if (ch) {
        e.channelId = ch.id;
        e.channelName = ch.name;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            fromDiscord = await this._readChannel(ch);
            break;
          } catch (err) {
            console.warn(`[store] 백업 읽기 실패 (${attempt}/3): ${err.message}`);
            if (attempt === 3) e.noPrune = true; // 못 읽었으면 예전 백업을 절대 지우지 않음
            else await sleep(1500 * attempt);
          }
        }
      }
    }
    const fromLocal = this._readLocal(gid);
    const best = [fromDiscord, fromLocal].filter(Boolean).sort((x, y) => (y.savedAt || 0) - (x.savedAt || 0))[0] || null;
    return normalizeState(best);
  }

  async _resolveChannel(guild) {
    if (cfg.DATA_CHANNEL_ID) {
      const c = await guild.channels.fetch(cfg.DATA_CHANNEL_ID).catch(() => null);
      if (c && typeof c.send === 'function') return c;
    }
    const all = await guild.channels.fetch().catch(() => null);
    const found = all?.find((c) => c && c.type === ChannelType.GuildText && c.name === cfg.DATA_CHANNEL_NAME);
    if (found) return found;

    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      console.warn(`[store] ${guild.name}: 채널 관리 권한이 없어 #${cfg.DATA_CHANNEL_NAME} 을 못 만듦 → 로컬 저장만 사용`);
      return null;
    }
    const created = await guild.channels
      .create({
        name: cfg.DATA_CHANNEL_NAME,
        type: ChannelType.GuildText,
        topic: '⚔️ 피파 전쟁 봇 전적 저장소 — 채널/메시지 삭제 금지 (전적이 날아가요)',
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          {
            id: me.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
        ],
        reason: '피파 전쟁 봇 전적 백업용 (Render 무료 플랜 대응)',
      })
      .catch((err) => {
        console.warn(`[store] ${guild.name}: 데이터 채널 생성 실패 → ${err.message}`);
        return null;
      });
    if (created) console.log(`[store] ${guild.name}: 숨김 채널 #${created.name} 생성`);
    return created;
  }

  _isBackup(m) {
    const me = this.getClient()?.user?.id;
    return m.author?.id === me && m.attachments.some((a) => a.name === FILE_NAME);
  }

  async _backups(ch) {
    const msgs = await ch.messages.fetch({ limit: 30 });
    return [...msgs.values()].filter((m) => this._isBackup(m)).sort((x, y) => y.createdTimestamp - x.createdTimestamp);
  }

  async _readChannel(ch) {
    const list = await this._backups(ch);
    for (const msg of list) {
      const att = msg.attachments.find((a) => a.name === FILE_NAME);
      try {
        const res = await fetch(att.url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = JSON.parse(await res.text());
        if (json && typeof json === 'object') return json;
      } catch (err) {
        console.warn(`[store] 백업 하나 손상 → 이전 백업 시도 (${err.message})`);
      }
    }
    return null; // 백업 없음 = 첫 실행
  }

  // ───────── 저장 ─────────
  async _writeDiscord(gid, e, json) {
    if (!e.channelId) return;
    const client = this.getClient();
    if (!client?.isReady()) return;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const ch = await client.channels.fetch(e.channelId);
        await ch.send({
          content: `💾 전적 백업 · <t:${Math.floor(Date.now() / 1000)}:f>`,
          files: [new AttachmentBuilder(Buffer.from(json, 'utf8'), { name: FILE_NAME })],
          allowedMentions: { parse: [] },
        });
        e.lastSavedAt = Date.now();
        e.lastError = '';
        if (!e.noPrune) {
          const list = await this._backups(ch);
          for (const old of list.slice(KEEP)) await old.delete().catch(() => {});
        }
        return;
      } catch (err) {
        e.lastError = err.message;
        console.warn(`[store] 디스코드 백업 실패 (${attempt}/2): ${err.message}`);
        if (attempt === 1 && (err.code === 10003 || err.code === 50001)) {
          // 채널이 지워졌거나 접근 불가 → 다시 찾기/생성
          const guild = await client.guilds.fetch(gid).catch(() => null);
          const ch = guild ? await this._resolveChannel(guild) : null;
          e.channelId = ch?.id || '';
          e.channelName = ch?.name || '';
          if (!ch) return;
        } else if (attempt === 1) {
          await sleep(2000);
        }
      }
    }
  }

  _localFile(gid) {
    return path.join(LOCAL_DIR, `${gid}.json`);
  }

  _readLocal(gid) {
    try {
      const raw = fs.readFileSync(this._localFile(gid), 'utf8');
      const json = JSON.parse(raw);
      return json && typeof json === 'object' ? json : null;
    } catch {
      return null;
    }
  }

  _writeLocal(gid, json) {
    try {
      fs.mkdirSync(LOCAL_DIR, { recursive: true });
      const file = this._localFile(gid);
      fs.writeFileSync(`${file}.tmp`, json);
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      console.warn('[store] 로컬 저장 실패:', err.message);
    }
  }
}

module.exports = { Store, FILE_NAME };
