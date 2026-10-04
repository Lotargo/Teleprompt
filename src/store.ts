import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { alias, botToken, chatId, description, displayName, policyInput, tokenEnv, TelepromptError, type Bot, type Policy, type PolicyInput, type Target, type TgMessage, type Update } from './types.js';
import { Secrets } from './secrets.js';
import type { Workspace } from './workspace.js';

export function dataHome(env = process.env): string {
  if (env.TELEPROMPT_HOME) {
    if (!isAbsolute(env.TELEPROMPT_HOME)) throw new TelepromptError('INVALID_HOME', 'TELEPROMPT_HOME must be absolute so all workspaces share the same runtime.');
    return env.TELEPROMPT_HOME;
  }
  return process.platform === 'win32' ? join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Teleprompt') : join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'teleprompt');
}

export class Store {
  readonly db: DatabaseSync;
  readonly secrets: Secrets;
  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.secrets = new Secrets(path);
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 2) { this.db.close(); throw new TelepromptError('NEWER_DATABASE', 'This database requires a newer Teleprompt version.'); }
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS bots(alias TEXT PRIMARY KEY, token_env TEXT NOT NULL, telegram_id TEXT NOT NULL UNIQUE, username TEXT);
      CREATE TABLE IF NOT EXISTS targets(alias TEXT PRIMARY KEY, bot_alias TEXT NOT NULL REFERENCES bots(alias), chat_id TEXT NOT NULL, writable INTEGER NOT NULL DEFAULT 0, UNIQUE(bot_alias,chat_id));
      CREATE TABLE IF NOT EXISTS collectors(bot_alias TEXT PRIMARY KEY REFERENCES bots(alias), next_offset INTEGER NOT NULL DEFAULT 0, first_sync INTEGER, last_sync INTEGER, last_error TEXT);
      CREATE TABLE IF NOT EXISTS leases(bot_alias TEXT PRIMARY KEY REFERENCES bots(alias), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(bot_alias TEXT NOT NULL REFERENCES bots(alias), chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, date INTEGER NOT NULL, edit_date INTEGER NOT NULL DEFAULT 0, sender_id TEXT, sender_name TEXT, is_bot INTEGER NOT NULL DEFAULT 0, text TEXT, thread_id INTEGER, deleted INTEGER NOT NULL DEFAULT 0, raw TEXT NOT NULL, observed_at INTEGER NOT NULL, PRIMARY KEY(bot_alias,chat_id,message_id));
      CREATE INDEX IF NOT EXISTS messages_date ON messages(bot_alias,chat_id,date);
      CREATE TABLE IF NOT EXISTS updates(bot_alias TEXT NOT NULL REFERENCES bots(alias), update_id INTEGER NOT NULL, received_at INTEGER NOT NULL, kind TEXT NOT NULL, raw TEXT NOT NULL, PRIMARY KEY(bot_alias,update_id));
      CREATE TABLE IF NOT EXISTS operations(request_id TEXT PRIMARY KEY, target TEXT NOT NULL, method TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    if (version < 2) this.transaction(() => {
      if (Number(this.db.prepare('PRAGMA user_version').get()!.user_version) >= 2) return;
      this.db.exec(`ALTER TABLE bots ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
        ALTER TABLE bots ADD COLUMN description TEXT NOT NULL DEFAULT '';
        ALTER TABLE targets ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
        ALTER TABLE targets ADD COLUMN description TEXT NOT NULL DEFAULT '';
        ALTER TABLE targets ADD COLUMN username TEXT;
        CREATE TABLE bot_secrets(bot_alias TEXT PRIMARY KEY REFERENCES bots(alias), ciphertext TEXT NOT NULL);
        CREATE TABLE policies(id TEXT PRIMARY KEY, mode TEXT NOT NULL, rules TEXT NOT NULL, manage INTEGER NOT NULL, description TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE bindings(scope_key TEXT PRIMARY KEY, policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE, kind TEXT NOT NULL, directory TEXT NOT NULL, repository_root TEXT, label TEXT NOT NULL);
        PRAGMA user_version=2;`);
    });
  }
  close() { this.db.close(); }
  transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = body(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  addBot(value: Bot, token?: string) {
    alias.parse(value.alias);
    if (token !== undefined) botToken.parse(token); else tokenEnv.parse(value.token_env);
    if (!/^\d+$/.test(value.telegram_id)) throw new TelepromptError('INVALID_BOT', 'Invalid bot identity');
    // Rebinding an existing alias would silently redirect every target and archive.
    if (this.bots().some(b => b.alias === value.alias || b.telegram_id === value.telegram_id)) throw new TelepromptError('BOT_EXISTS', 'Bot alias or Telegram identity already registered.');
    this.transaction(() => {
      this.db.prepare('INSERT INTO bots(alias,token_env,telegram_id,username,display_name,description) VALUES(?,?,?,?,?,?)').run(value.alias, token !== undefined ? '' : value.token_env, value.telegram_id, value.username, value.display_name || value.alias, description.parse(value.description || ''));
      this.db.prepare('INSERT INTO collectors(bot_alias) VALUES(?)').run(value.alias);
      if (token !== undefined) this.saveToken(value.alias, token);
    });
  }
  bots(): Bot[] { return this.db.prepare("SELECT bots.*, CASE WHEN EXISTS(SELECT 1 FROM bot_secrets WHERE bot_alias=bots.alias) THEN 'local' ELSE 'environment' END credential_kind FROM bots ORDER BY alias").all() as unknown as Bot[]; }
  savedToken(name: string): string | undefined {
    const row = this.db.prepare('SELECT ciphertext FROM bot_secrets WHERE bot_alias=?').get(name);
    return row ? this.secrets.decrypt(String(row.ciphertext), this.bot(name).telegram_id) : undefined;
  }
  saveToken(name: string, token: string) {
    botToken.parse(token);
    const bot = this.bot(name);
    this.db.prepare('INSERT OR REPLACE INTO bot_secrets VALUES(?,?)').run(name, this.secrets.encrypt(token, bot.telegram_id));
    this.db.prepare("UPDATE bots SET token_env='' WHERE alias=?").run(name);
  }
  updateBot(name: string, patch: { display_name?: string; description?: string; username?: string | null }) {
    const bot = this.bot(name);
    this.db.prepare('UPDATE bots SET display_name=?,description=?,username=? WHERE alias=?').run(
      patch.display_name === undefined ? bot.display_name || bot.alias : displayName.parse(patch.display_name),
      patch.description === undefined ? bot.description || '' : description.parse(patch.description),
      patch.username === undefined ? bot.username : patch.username, name);
    return this.bot(name);
  }
  bot(name: string): Bot {
    const bot = this.bots().find(b => b.alias === name);
    if (!bot) throw new TelepromptError('BOT_NOT_FOUND', `Unknown bot alias: ${name}`);
    return bot;
  }
  addTarget(value: Target) {
    alias.parse(value.alias); chatId.parse(value.chat_id); this.bot(value.bot_alias);
    if (value.writable !== 0 && value.writable !== 1) throw new TelepromptError('INVALID_PERMISSION', 'writable must be 0 or 1');
    this.db.prepare('INSERT INTO targets(alias,bot_alias,chat_id,writable,display_name,description,username) VALUES(?,?,?,?,?,?,?)').run(value.alias, value.bot_alias, value.chat_id, value.writable, value.display_name || value.alias, description.parse(value.description || ''), value.username || null);
  }
  targets(): Target[] { return this.db.prepare('SELECT * FROM targets ORDER BY alias').all() as unknown as Target[]; }
  target(name: string, write = false): Target {
    const target = this.targets().find(t => t.alias === name);
    if (!target) throw new TelepromptError('TARGET_NOT_FOUND', `Unknown chat alias: ${name}`);
    if (write && !target.writable) throw new TelepromptError('READ_ONLY_TARGET', `Chat ${name} is configured for inspection only. Enable writing locally before publishing.`);
    return target;
  }
  setWritable(name: string, writable: boolean) {
    this.target(name); this.db.prepare('UPDATE targets SET writable=? WHERE alias=?').run(Number(writable), name);
  }
  updateTarget(name: string, patch: { display_name?: string; description?: string; writable?: boolean }) {
    const target = this.target(name);
    this.db.prepare('UPDATE targets SET display_name=?,description=?,writable=? WHERE alias=?').run(
      patch.display_name === undefined ? target.display_name || target.alias : displayName.parse(patch.display_name),
      patch.description === undefined ? target.description || '' : description.parse(patch.description),
      patch.writable === undefined ? target.writable : Number(patch.writable), name);
    return this.target(name);
  }
  policy(id: string): Policy | undefined {
    const row = this.db.prepare('SELECT * FROM policies WHERE id=?').get(id);
    return row ? { id: String(row.id), mode: row.mode as Policy['mode'], rules: JSON.parse(String(row.rules)), manage: Boolean(row.manage), description: String(row.description), revision: Number(row.revision), updated_at: Number(row.updated_at) } : undefined;
  }
  policies(): Policy[] { return this.db.prepare('SELECT id FROM policies ORDER BY id').all().map(row => this.policy(String(row.id))!); }
  currentPolicy(workspace: Workspace): Policy | undefined {
    const row = this.db.prepare('SELECT policy_id FROM bindings WHERE scope_key=?').get(workspace.key);
    return row ? this.policy(String(row.policy_id)) : undefined;
  }
  setPolicy(id: string, input: PolicyInput, expectedRevision?: number): Policy {
    alias.parse(id);
    const value = policyInput.parse(input), current = this.policy(id);
    if (current && expectedRevision === undefined) throw new TelepromptError('REVISION_REQUIRED', 'Specify the current policy revision before editing.');
    if ((current?.revision || 0) !== (expectedRevision || 0)) throw new TelepromptError('POLICY_CONFLICT', 'Policy changed; read its current revision before editing.');
    const seen = new Set<string>();
    for (const rule of value.rules) {
      const target = this.target(rule.target);
      if (target.bot_alias !== rule.bot) throw new TelepromptError('POLICY_PAIR_MISMATCH', 'Policy bot does not match the bot bound to its target.');
      if (seen.has(rule.target)) throw new TelepromptError('DUPLICATE_RULE', 'A target can occur only once in a policy.');
      seen.add(rule.target);
    }
    this.db.prepare('INSERT INTO policies VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,rules=excluded.rules,manage=excluded.manage,description=excluded.description,revision=excluded.revision,updated_at=excluded.updated_at')
      .run(id, value.mode, JSON.stringify(value.rules), Number(value.manage), value.description, (current?.revision || 0) + 1, Date.now());
    return this.policy(id)!;
  }
  bind(workspace: Workspace, policyId: string) {
    if (!this.policy(policyId)) throw new TelepromptError('POLICY_NOT_FOUND', 'Unknown policy.');
    this.db.prepare('INSERT OR REPLACE INTO bindings VALUES(?,?,?,?,?,?)').run(workspace.key, policyId, workspace.kind, workspace.directory, workspace.repository_root, workspace.label);
  }
  bindings() { return this.db.prepare('SELECT * FROM bindings ORDER BY scope_key').all(); }
  unbind(scope: string, expectedPolicy: string) {
    const result = this.db.prepare('DELETE FROM bindings WHERE scope_key=? AND policy_id=?').run(scope, expectedPolicy);
    if (!Number(result.changes)) throw new TelepromptError('BINDING_CONFLICT', 'Binding missing or changed; inspect it before deleting.');
  }
  deletePolicy(id: string, expectedRevision: number) {
    if (this.policy(id)?.revision !== expectedRevision) throw new TelepromptError('POLICY_CONFLICT', 'Policy missing or changed; inspect it before deleting.');
    this.db.prepare('DELETE FROM policies WHERE id=?').run(id);
  }
  collector(bot: string) {
    this.bot(bot); return this.db.prepare('SELECT * FROM collectors WHERE bot_alias=?').get(bot)!;
  }
  acquire(bot: string, owner: string, now = Date.now()) {
    return this.transaction(() => {
      this.bot(bot);
      const lease = this.db.prepare('SELECT * FROM leases WHERE bot_alias=?').get(bot);
      if (lease && Number(lease.expires_at) > now) throw new TelepromptError('COLLECTOR_BUSY', 'Another collector owns this bot. Retry later.');
      this.db.prepare('INSERT OR REPLACE INTO leases VALUES(?,?,?)').run(bot, owner, now + 90_000);
    });
  }
  release(bot: string, owner: string) { this.db.prepare('DELETE FROM leases WHERE bot_alias=? AND owner=?').run(bot, owner); }
  saveMessage(bot: string, message: TgMessage) {
    const sender = message.from;
    this.db.prepare(`INSERT INTO messages(bot_alias,chat_id,message_id,date,edit_date,sender_id,sender_name,is_bot,text,thread_id,raw,observed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(bot_alias,chat_id,message_id) DO UPDATE SET
      edit_date=excluded.edit_date, text=excluded.text, raw=excluded.raw, observed_at=excluded.observed_at
      WHERE excluded.edit_date >= messages.edit_date`).run(
      bot, String(message.chat.id), message.message_id, message.date, message.edit_date || 0,
      sender ? String(sender.id) : message.sender_chat ? `chat:${message.sender_chat.id}` : null,
      sender?.username || sender?.first_name || message.sender_chat?.title || null, Number(sender?.is_bot || false),
      message.text ?? message.caption ?? null, message.message_thread_id ?? null, JSON.stringify(message), Date.now());
  }
  commitUpdates(bot: string, owner: string, updates: Update[], now = Date.now()) {
    return this.transaction(() => {
      const lease = this.db.prepare('SELECT * FROM leases WHERE bot_alias=? AND owner=? AND expires_at>?').get(bot, owner, now);
      if (!lease) throw new TelepromptError('LEASE_LOST', 'Collector lease expired. Updates were not acknowledged locally.');
      let offset = Number(this.collector(bot).next_offset);
      const allowed = new Set(this.targets().filter(t => t.bot_alias === bot).map(t => t.chat_id));
      for (const update of updates) {
        if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new TelepromptError('INVALID_UPDATE', 'Invalid Telegram update_id');
        offset = Math.max(offset, update.update_id + 1);
        const kind = Object.keys(update).find(k => k !== 'update_id') || 'unknown';
        const message = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
        const chat = message?.chat || (update[kind] as { chat?: { id: number } } | undefined)?.chat;
        if (!chat || !allowed.has(String(chat.id))) continue;
        const inserted = this.db.prepare('INSERT OR IGNORE INTO updates VALUES(?,?,?,?,?)').run(bot, update.update_id, now, kind, JSON.stringify(update));
        if (Number(inserted.changes) > 0 && message) this.saveMessage(bot, message);
      }
      this.db.prepare('UPDATE collectors SET next_offset=?, first_sync=COALESCE(first_sync,?), last_sync=?, last_error=NULL WHERE bot_alias=?').run(offset, now, now, bot);
      return { received: updates.length, next_offset: offset };
    });
  }
  operation(id: string) { return this.db.prepare('SELECT * FROM operations WHERE request_id=?').get(id); }
  audit(limit = 30) {
    return this.db.prepare('SELECT request_id,target,method,state,created_at,updated_at,error FROM operations ORDER BY created_at DESC LIMIT ?').all(limit);
  }
}
