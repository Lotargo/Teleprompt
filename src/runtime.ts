import { createHash, randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { TelegramApiError } from './telegram.js';
import { alias, botToken, tokenEnv, chatId, coverageNotice, messagesInput, statsInput, writeInput, description, displayName, TelepromptError, type Bot, type PolicyInput, type Target, type TelegramTransport, type TgMessage, type Update } from './types.js';
import { resolveWorkspace, type Workspace } from './workspace.js';

export class Runtime {
  constructor(readonly store: Store, readonly telegram: TelegramTransport, public workspace: Workspace = resolveWorkspace(), private administrative = false) {}
  context() { return { workspace: this.workspace, policy: this.store.currentPolicy(this.workspace) || null, setup_required: !this.store.currentPolicy(this.workspace) }; }
  canAccess(target: Target, access: 'read' | 'write'): boolean {
    const policy = this.store.currentPolicy(this.workspace);
    return !!policy && (policy.mode === 'all' || (policy.mode === 'selected' && policy.rules.some(rule => rule.bot === target.bot_alias && rule.target === target.alias && rule[access])));
  }
  private requirePolicy() {
    const policy = this.store.currentPolicy(this.workspace);
    if (!policy) throw new TelepromptError('POLICY_REQUIRED', 'No access policy is bound to this workspace. Ask the human which bot/chat to allow, then configure a policy.', { workspace: this.workspace.key });
    if (policy.mode === 'deny') throw new TelepromptError('PERMISSION_DENIED', 'Telegram access is disabled for this workspace.');
    return policy;
  }
  requireManage(bootstrap = false) {
    const policy = this.store.currentPolicy(this.workspace);
    if (this.administrative || (policy?.mode !== 'deny' && policy?.manage) || (bootstrap && !policy)) return;
    this.requirePolicy();
    throw new TelepromptError('ADMIN_REQUIRED', 'This workspace cannot change Telegram configuration. Use an authorized management workspace or the human-approved local administrative CLI.');
  }
  private target(name: string, access: 'read' | 'write') {
    this.requirePolicy();
    const target = this.store.target(name);
    if (!this.canAccess(target, access)) throw new TelepromptError('PERMISSION_DENIED', 'This bot/chat is not permitted by the current workspace policy.');
    return access === 'write' ? this.store.target(name, true) : target;
  }
  inventory() {
    const policy = this.store.currentPolicy(this.workspace), setup = !policy;
    const targets = this.store.targets().filter(t => setup || policy?.manage || this.canAccess(t, 'read'));
    const botNames = new Set(targets.map(t => t.bot_alias));
    const bots = this.store.bots().filter(b => setup || policy?.manage || policy?.mode === 'all' || botNames.has(b.alias));
    return { ...this.context(), bots, targets: targets.map(t => ({ ...t, access: { read: this.canAccess(t, 'read'), write: !!t.writable && this.canAccess(t, 'write') } })), collectors: setup ? [] : bots.filter(b => targets.some(t => t.bot_alias === b.alias && this.canAccess(t, 'read'))).map(b => this.store.collector(b.alias)), coverage: coverageNotice };
  }
  async addBot(name: string, env: string, metadata: { display_name?: string; description?: string } = {}) {
    return this.registerBot({ alias: name, token_env: env, ...metadata });
  }
  async registerBot(input: { alias: string; token?: string; token_env?: string; display_name?: string; description?: string }) {
    this.requireManage(true); alias.parse(input.alias);
    if ((input.token !== undefined) === (input.token_env !== undefined)) throw new TelepromptError('CREDENTIAL_REQUIRED', 'Provide exactly one bot token or token_env.');
    if (input.token !== undefined) botToken.parse(input.token); else tokenEnv.parse(input.token_env);
    const provisional: Bot = { alias: input.alias, token_env: input.token_env || '', telegram_id: '0', username: null };
    const me = await this.telegram.call<{ id: number; is_bot: boolean; username?: string; first_name?: string }>(provisional, 'getMe', {}, undefined, input.token);
    this.requireManage(true);
    if (!me.is_bot || !Number.isSafeInteger(me.id) || me.id <= 0) throw new TelepromptError('INVALID_BOT', 'Token does not identify a verified bot.');
    this.store.addBot({ ...provisional, telegram_id: String(me.id), username: me.username || null, display_name: displayName.parse(input.display_name || me.first_name || input.alias), description: description.parse(input.description || '') }, input.token);
    return this.store.bot(input.alias);
  }
  async updateBot(name: string, patch: { token?: string; display_name?: string; description?: string }) {
    this.requireManage(); const bot = this.store.bot(name);
    let username: string | null | undefined;
    if (patch.token !== undefined) {
      botToken.parse(patch.token);
      const me = await this.telegram.call<{ id: number; is_bot: boolean; username?: string }>(bot, 'getMe', {}, undefined, patch.token);
      if (!me.is_bot || String(me.id) !== bot.telegram_id) throw new TelepromptError('BOT_IDENTITY_MISMATCH', 'Replacement token belongs to a different bot; the existing alias was not changed.');
      username = me.username || null;
    }
    this.requireManage();
    return this.store.transaction(() => {
      this.store.updateBot(name, { display_name: patch.display_name, description: patch.description, username });
      if (patch.token !== undefined) this.store.saveToken(name, patch.token);
      return this.store.bot(name);
    });
  }
  async addTarget(name: string, botName: string, reference: string, writable = false, metadata: { display_name?: string; description?: string } = {}) {
    this.requireManage(true); alias.parse(name);
    let id = reference;
    if (/^https:\/\//.test(id)) {
      const url = new URL(id);
      if (!['t.me', 'telegram.me'].includes(url.hostname) || !/^\/[A-Za-z0-9_]+\/?$/.test(url.pathname)) throw new TelepromptError('INVALID_CHAT_REFERENCE', 'Use a public Telegram chat link, @username or numeric chat ID.');
      id = '@' + url.pathname.replaceAll('/', '');
    }
    if (id.startsWith('@')) {
      if (!/^@[A-Za-z0-9_]{5,32}$/.test(id)) throw new TelepromptError('INVALID_CHAT_REFERENCE', 'Invalid public Telegram username.');
    } else chatId.parse(id);
    const bot = this.store.bot(botName);
    const chat = await this.telegram.call<{ id: number; type: string; title?: string; username?: string }>(bot, 'getChat', { chat_id: id });
    this.requireManage(true);
    chatId.parse(String(chat.id));
    if (!id.startsWith('@') && String(chat.id) !== id) throw new TelepromptError('CHAT_MISMATCH', 'Telegram returned a different chat ID.');
    this.store.addTarget({ alias: name, bot_alias: botName, chat_id: String(chat.id), writable: Number(writable), display_name: displayName.parse(metadata.display_name || chat.title || name), description: description.parse(metadata.description || ''), username: chat.username || null });
    return { target: this.store.target(name), chat };
  }
  updateTarget(name: string, patch: { display_name?: string; description?: string; writable?: boolean }) { this.requireManage(); return this.store.updateTarget(name, patch); }
  configurePolicy(id: string, input: PolicyInput, expectedRevision?: number) {
    this.requireManage(true);
    return this.store.transaction(() => {
      if (!this.store.currentPolicy(this.workspace) && !this.administrative && this.store.policy(id)) throw new TelepromptError('ADMIN_REQUIRED', 'Initial setup can create a new policy for this workspace, not modify a policy belonging to another workspace.');
      const policy = this.store.setPolicy(id, input, expectedRevision);
      this.store.bind(this.workspace, id); return { ...this.context(), policy };
    });
  }
  policies() { this.requireManage(); return { policies: this.store.policies(), bindings: this.store.bindings() }; }
  setPolicy(id: string, input: PolicyInput, revision?: number) { this.requireManage(); return this.store.transaction(() => this.store.setPolicy(id, input, revision)); }
  bindPolicy(directory: string, id: string) { this.requireManage(); const workspace = resolveWorkspace(directory); this.store.bind(workspace, id); return { workspace, policy: this.store.policy(id) }; }
  unbindPolicy(scope: string, expectedPolicy: string) { this.requireManage(); this.store.unbind(scope, expectedPolicy); return { scope_key: scope, setup_required: true }; }
  deletePolicy(id: string, revision: number) { this.requireManage(); this.store.transaction(() => this.store.deletePolicy(id, revision)); return { deleted: id }; }
  audit(limit = 30) {
    this.requirePolicy();
    const targets = this.store.targets().filter(t => this.canAccess(t, 'read')).map(t => t.alias);
    if (!targets.length) return [];
    return this.store.db.prepare(`SELECT request_id,target,method,state,created_at,updated_at,error FROM operations WHERE target IN (${targets.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT ?`).all(...targets, limit);
  }
  operation(id: string) {
    this.requirePolicy(); const row = this.store.operation(id);
    if (!row) throw new TelepromptError('OPERATION_NOT_FOUND', 'No operation with this request_id.');
    this.target(String(row.target), 'read');
    return { request_id: row.request_id, target: row.target, method: row.method, state: row.state, result: row.result ? JSON.parse(String(row.result)) : null, error: row.error };
  }
  async inspect(name: string) {
    const target = this.target(name, 'read'), bot = this.store.bot(target.bot_alias);
    const [chat, memberCount, botMembership, me] = await Promise.all([
      this.telegram.call(bot, 'getChat', { chat_id: target.chat_id }),
      this.telegram.call(bot, 'getChatMemberCount', { chat_id: target.chat_id }),
      this.telegram.call(bot, 'getChatMember', { chat_id: target.chat_id, user_id: Number(bot.telegram_id) }),
      this.telegram.call(bot, 'getMe')
    ]);
    this.target(name, 'read');
    return { target, chat, member_count_now: memberCount, bot_membership: botMembership, bot: me, collector: this.store.collector(bot.alias), coverage: coverageNotice };
  }
  async sync(name: string, timeout = 0, signal?: AbortSignal) {
    this.requireManage();
    const bot = this.store.bot(name), owner = randomUUID();
    this.store.acquire(name, owner);
    try {
      const info = await this.telegram.call<{ url: string }>(bot, 'getWebhookInfo', {}, signal);
      if (info.url) throw new TelepromptError('WEBHOOK_ACTIVE', 'Bot has a webhook. Polling cannot start; configure a dedicated bot or explicitly migrate its update consumer.');
      const updates = await this.telegram.call<Update[]>(bot, 'getUpdates', {
        offset: this.store.collector(name).next_offset, timeout, limit: 100,
        allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'my_chat_member', 'message_reaction', 'message_reaction_count']
      }, signal);
      if (!Array.isArray(updates)) throw new TelepromptError('INVALID_UPDATES', 'Telegram did not return an update array.');
      this.requireManage();
      return this.store.commitUpdates(name, owner, updates);
    } catch (error) {
      const code = error instanceof TelepromptError ? error.code : 'COLLECTOR_ERROR';
      this.store.db.prepare('UPDATE collectors SET last_error=? WHERE bot_alias=? AND EXISTS(SELECT 1 FROM leases WHERE bot_alias=? AND owner=?)').run(code, name, name, owner);
      throw error;
    } finally { this.store.release(name, owner); }
  }
  messages(input: unknown) {
    const args = messagesInput.parse(input), t = this.target(args.target, 'read');
    const rows = this.store.db.prepare(`SELECT message_id,date,edit_date,sender_id,sender_name,is_bot,text,thread_id,deleted,observed_at FROM messages
      WHERE bot_alias=? AND chat_id=? AND message_id<? AND (?='' OR instr(COALESCE(text,''),?)>0)
      ORDER BY message_id DESC LIMIT ?`).all(t.bot_alias, t.chat_id, args.before_message_id || Number.MAX_SAFE_INTEGER, args.query || '', args.query || '', args.limit);
    return { target: t, messages: rows, next_before_message_id: rows.length === args.limit ? rows[rows.length - 1]!.message_id : null, collector: this.store.collector(t.bot_alias), coverage: coverageNotice };
  }
  message(name: string, messageId: number) {
    const t = this.target(name, 'read');
    const row = this.store.db.prepare('SELECT raw,deleted,observed_at FROM messages WHERE bot_alias=? AND chat_id=? AND message_id=?').get(t.bot_alias, t.chat_id, messageId);
    if (!row) throw new TelepromptError('MESSAGE_NOT_ARCHIVED', 'Message is not in the local archive. Bot API cannot fetch arbitrary history by message ID.');
    return { target: t, message: JSON.parse(String(row.raw)), deleted: Boolean(row.deleted), observed_at: row.observed_at, coverage: coverageNotice };
  }
  stats(input: unknown) {
    const args = statsInput.parse(input), t = this.target(args.target, 'read');
    const since = args.since ? Date.parse(args.since) / 1000 : 0, until = args.until ? Date.parse(args.until) / 1000 : Date.now() / 1000;
    if (since > until) throw new TelepromptError('INVALID_RANGE', 'since must be before until.');
    const summary = this.store.db.prepare(`SELECT count(*) observed_messages, COALESCE(sum(is_bot),0) bot_messages, COALESCE(sum(deleted),0) locally_deleted_messages,
      count(DISTINCT CASE WHEN is_bot=0 THEN sender_id END) observed_senders, min(date) first_message_at, max(date) last_message_at
      FROM messages WHERE bot_alias=? AND chat_id=? AND date>=? AND date<=?`).get(t.bot_alias, t.chat_id, since, until);
    const activity = this.store.db.prepare(`SELECT strftime('%Y-%m-%d',date,'unixepoch') day_utc,count(*) messages FROM messages
      WHERE bot_alias=? AND chat_id=? AND date>=? AND date<=? GROUP BY day_utc ORDER BY day_utc`).all(t.bot_alias, t.chat_id, since, until);
    const senders = this.store.db.prepare(`SELECT sender_id, max(sender_name) sender_name, count(*) messages FROM messages
      WHERE bot_alias=? AND chat_id=? AND date>=? AND date<=? AND sender_id IS NOT NULL GROUP BY sender_id ORDER BY messages DESC LIMIT 20`).all(t.bot_alias, t.chat_id, since, until);
    return { target: t, requested_range: { since: args.since || null, until: args.until || null }, summary, activity, senders, collector: this.store.collector(t.bot_alias), coverage: coverageNotice };
  }
  async write(name: string, requestId: string, method: string, params: Record<string, unknown>) {
    writeInput.parse({ target: name, request_id: requestId });
    const returnsMessage = ['sendMessage', 'editMessageText', 'sendPhoto', 'sendDocument'].includes(method);
    if (!returnsMessage && !['deleteMessage', 'pinChatMessage', 'unpinChatMessage'].includes(method)) throw new TelepromptError('UNSUPPORTED_ACTION', 'This Telegram write method is not exposed by Teleprompt.');
    const t = this.target(name, 'write'), bot = this.store.bot(t.bot_alias);
    const payload = { ...params, chat_id: t.chat_id };
    const fingerprint = createHash('sha256').update(JSON.stringify({ target: t.alias, bot: bot.telegram_id, method, payload })).digest('hex');
    const existing = this.store.transaction(() => {
      const previous = this.store.operation(requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new TelepromptError('IDEMPOTENCY_CONFLICT', 'request_id already belongs to a different action.');
        if (previous.state !== 'succeeded') throw new TelepromptError('OPERATION_UNRESOLVED', `Previous action state: ${previous.state}. Inspect the audit and Telegram before attempting another request.`, { request_id: requestId });
        return previous;
      }
      const now = Date.now();
      this.store.db.prepare('INSERT INTO operations(request_id,target,method,fingerprint,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(requestId, name, method, fingerprint, 'pending', now, now);
      return undefined;
    });
    if (existing) return { request_id: requestId, state: 'succeeded', replayed: true, result: JSON.parse(String(existing.result)) };
    try {
      const result = await this.telegram.call(bot, method, payload);
      if (returnsMessage) {
        const message = result as Partial<TgMessage> | null;
        if (!message || !Number.isSafeInteger(message.message_id) || Number(message.message_id) <= 0 || !Number.isSafeInteger(message.date) || String(message.chat?.id) !== t.chat_id) {
          throw new TelepromptError('TRANSPORT_UNKNOWN', 'Telegram write returned an unverified message or destination. Inspect Telegram before resubmitting.');
        }
      } else if (result !== true) throw new TelepromptError('TRANSPORT_UNKNOWN', 'Telegram write did not return a verified success. Inspect Telegram before resubmitting.');
      this.store.transaction(() => {
        if (result && typeof result === 'object' && 'message_id' in result) this.store.saveMessage(bot.alias, result as TgMessage);
        if (method === 'deleteMessage' && result === true) this.store.db.prepare('UPDATE messages SET deleted=1 WHERE bot_alias=? AND chat_id=? AND message_id=?').run(bot.alias, t.chat_id, Number(params.message_id));
        this.store.db.prepare("UPDATE operations SET state='succeeded',result=?,updated_at=? WHERE request_id=?").run(JSON.stringify(result), Date.now(), requestId);
      });
      this.target(name, 'read');
      return { request_id: requestId, state: 'succeeded', replayed: false, result };
    } catch (error) {
      if (this.store.operation(requestId)?.state === 'succeeded') throw error;
      const knownFailure = error instanceof TelegramApiError || (error instanceof TelepromptError && ['MISSING_TOKEN', 'INVALID_TOKEN'].includes(error.code));
      const state = knownFailure ? 'failed' : 'unknown';
      const code = error instanceof TelepromptError ? error.code : 'LOCAL_OR_TRANSPORT_ERROR';
      this.store.db.prepare('UPDATE operations SET state=?,error=?,updated_at=? WHERE request_id=?').run(state, code, Date.now(), requestId);
      if (error instanceof TelepromptError) throw error;
      throw new TelepromptError('OPERATION_UNKNOWN', 'Operation outcome is unknown; inspect the audit and Telegram before sending another request.', { request_id: requestId });
    }
  }
}
