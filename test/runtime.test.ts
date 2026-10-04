import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, dataHome } from '../src/store.js';
import { Runtime } from '../src/runtime.js';
import { Telegram, TelegramApiError } from '../src/telegram.js';
import { TelepromptError, type Bot, type TelegramTransport, type TgMessage, type Update } from '../src/types.js';
import { resolveWorkspace } from '../src/workspace.js';

class FakeTelegram implements TelegramTransport {
  calls: { bot: string; method: string; params: Record<string, unknown> }[] = [];
  handler: (bot: Bot, method: string, params: Record<string, unknown>) => unknown | Promise<unknown> = (_bot, method, params) => {
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getUpdates') return [];
    if (method === 'sendMessage' || method === 'editMessageText') return message(Number(params.message_id || 50), String(params.text), 2000, Number(params.chat_id));
    return true;
  };
  async call<T>(bot: Bot, method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ bot: bot.alias, method, params }); return await this.handler(bot, method, params) as T;
  }
}
function message(id = 1, text = 'Hello', date = 1000, chat = -100123): TgMessage {
  return { message_id: id, date, chat: { id: chat, type: 'supergroup' }, from: { id: 7, first_name: 'Alice' }, text };
}
function fixture(path = ':memory:') {
  const store = new Store(path), telegram = new FakeTelegram();
  store.addBot({ alias: 'news', token_env: 'TG_NEWS', telegram_id: '100', username: 'newsbot' });
  store.addBot({ alias: 'work', token_env: 'TG_WORK', telegram_id: '200', username: 'workbot' });
  store.addTarget({ alias: 'community', bot_alias: 'news', chat_id: '-100123', writable: 1 });
  store.addTarget({ alias: 'workroom', bot_alias: 'work', chat_id: '-100456', writable: 1 });
  store.addTarget({ alias: 'readroom', bot_alias: 'news', chat_id: '-100789', writable: 0 });
  store.setPolicy('test-all', { mode: 'all', rules: [], manage: true, description: 'Test fixture' });
  store.bind(resolveWorkspace(), 'test-all');
  return { store, telegram, runtime: new Runtime(store, telegram) };
}
const code = (expected: string) => (e: unknown) => e instanceof TelepromptError && e.code === expected;

test('home is independent of cwd and relative overrides are rejected', () => {
  assert.equal(dataHome({ TELEPROMPT_HOME: join(tmpdir(), 'teleprompt') }), join(tmpdir(), 'teleprompt'));
  assert.throws(() => dataHome({ TELEPROMPT_HOME: './data' }), code('INVALID_HOME'));
});
test('a bot identity cannot be registered under two aliases or silently rebound', t => {
  const f = fixture(); t.after(() => f.store.close());
  assert.throws(() => f.store.addBot({ alias: 'other', token_env: 'OTHER', telegram_id: '100', username: null }), code('BOT_EXISTS'));
  assert.throws(() => f.store.addBot({ alias: 'news', token_env: 'OTHER', telegram_id: '300', username: null }), code('BOT_EXISTS'));
});
test('target resolves the correct bot and chat even when payload tries another chat', async t => {
  const f = fixture(); t.after(() => f.store.close());
  await f.runtime.write('workroom', 'request-routing', 'sendMessage', { text: 'Hello', chat_id: '-9999' });
  assert.equal(f.telegram.calls[0]!.bot, 'work'); assert.equal(f.telegram.calls[0]!.params.chat_id, '-100456');
  assert.equal(f.runtime.messages({ target: 'community' }).messages.length, 0);
  assert.equal(f.runtime.messages({ target: 'workroom' }).messages.length, 1);
});
test('read-only and unknown targets never call Telegram', async t => {
  const f = fixture(); t.after(() => f.store.close());
  await assert.rejects(f.runtime.write('readroom', 'request-readonly', 'sendMessage', { text: 'Hello' }), code('READ_ONLY_TARGET'));
  await assert.rejects(f.runtime.write('absent', 'request-unknown', 'sendMessage', { text: 'Hello' }), code('TARGET_NOT_FOUND'));
  assert.equal(f.telegram.calls.length, 0);
});
test('successful request replay makes exactly one send and persists across processes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'teleprompt-')), path = join(dir, 'db.sqlite');
  const f = fixture(path); t.after(() => { f.store.close(); rmSync(dir, { recursive: true, force: true }); });
  await f.runtime.write('community', 'request-stable', 'sendMessage', { text: 'Hello' });
  const second = new Store(path);
  try {
    const replay = await new Runtime(second, f.telegram).write('community', 'request-stable', 'sendMessage', { text: 'Hello' });
    assert.equal(replay.replayed, true); assert.equal(f.telegram.calls.length, 1);
  } finally { second.close(); }
});
test('request IDs cannot be reused for changed text or a different target', async t => {
  const f = fixture(); t.after(() => f.store.close());
  await f.runtime.write('community', 'request-conflict', 'sendMessage', { text: 'Hello' });
  await assert.rejects(f.runtime.write('community', 'request-conflict', 'sendMessage', { text: 'Changed' }), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.runtime.write('workroom', 'request-conflict', 'sendMessage', { text: 'Hello' }), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(f.telegram.calls.length, 1);
});
test('simultaneous retries do not duplicate an in-flight publication', async t => {
  const f = fixture(); t.after(() => f.store.close());
  let complete!: (value: TgMessage) => void;
  f.telegram.handler = () => new Promise(resolve => { complete = resolve; });
  const first = f.runtime.write('community', 'request-pending', 'sendMessage', { text: 'Hello' });
  await assert.rejects(f.runtime.write('community', 'request-pending', 'sendMessage', { text: 'Hello' }), code('OPERATION_UNRESOLVED'));
  complete(message(50)); await first; assert.equal(f.telegram.calls.length, 1);
});
test('network ambiguity is persisted as unknown and never automatically resent', async t => {
  const f = fixture(); t.after(() => f.store.close());
  f.telegram.handler = () => { throw new TelepromptError('TRANSPORT_UNKNOWN', 'Response lost'); };
  await assert.rejects(f.runtime.write('community', 'request-lost-response', 'sendMessage', { text: 'Hello' }), code('TRANSPORT_UNKNOWN'));
  assert.equal(f.store.operation('request-lost-response')!.state, 'unknown');
  await assert.rejects(f.runtime.write('community', 'request-lost-response', 'sendMessage', { text: 'Hello' }), code('OPERATION_UNRESOLVED'));
  assert.equal(f.telegram.calls.length, 1);
});
test('Telegram rejection is failed with retry_after preserved and no retries', async t => {
  const f = fixture(); t.after(() => f.store.close());
  f.telegram.handler = () => { throw new TelegramApiError(429, 'Too many requests', 12); };
  await assert.rejects(f.runtime.write('community', 'request-rate-limit', 'sendMessage', { text: 'Hello' }), (e: unknown) => e instanceof TelepromptError && e.details?.retry_after === 12);
  assert.equal(f.store.operation('request-rate-limit')!.state, 'failed'); assert.equal(f.telegram.calls.length, 1);
});
test('an active webhook is refused without removing it or consuming updates', async t => {
  const f = fixture(); t.after(() => f.store.close());
  f.telegram.handler = () => ({ url: 'https://existing.example/hook' });
  await assert.rejects(f.runtime.sync('news'), code('WEBHOOK_ACTIVE'));
  assert.deepEqual(f.telegram.calls.map(c => c.method), ['getWebhookInfo']);
  assert.equal(f.store.collector('news').next_offset, 0);
  assert.equal(f.store.db.prepare('SELECT * FROM leases').all().length, 0);
});
test('leases exclude collectors on shared storage and expired owners cannot commit', t => {
  const dir = mkdtempSync(join(tmpdir(), 'teleprompt-')), path = join(dir, 'db.sqlite'), f = fixture(path), second = new Store(path);
  t.after(() => { second.close(); f.store.close(); rmSync(dir, { recursive: true, force: true }); });
  f.store.acquire('news', 'owner-a', 1000);
  assert.throws(() => second.acquire('news', 'owner-b', 1001), code('COLLECTOR_BUSY'));
  second.acquire('work', 'owner-b', 1001);
  second.acquire('news', 'owner-new', 100_000);
  assert.throws(() => f.store.commitUpdates('news', 'owner-a', [], 100_001), code('LEASE_LOST'));
  f.store.release('news', 'owner-a');
  assert.equal(second.db.prepare('SELECT owner FROM leases WHERE bot_alias=?').get('news')!.owner, 'owner-new');
});
test('updates and offsets commit atomically, duplicates deduplicate, and other chats are excluded', t => {
  const f = fixture(); t.after(() => f.store.close()); f.store.acquire('news', 'owner');
  const updates: Update[] = [{ update_id: 100, message: message() }, { update_id: 101, message: message(2, 'Unregistered', 1001, -9999) }];
  f.store.commitUpdates('news', 'owner', updates); f.store.commitUpdates('news', 'owner', updates);
  assert.equal(f.store.collector('news').next_offset, 102);
  assert.equal(f.store.db.prepare('SELECT * FROM updates').all().length, 1);
  assert.equal(f.store.db.prepare('SELECT * FROM messages').all().length, 1);
});
test('processing failure rolls back both archive and offset', t => {
  const f = fixture(); t.after(() => f.store.close()); f.store.acquire('news', 'owner');
  assert.throws(() => f.store.commitUpdates('news', 'owner', [{ update_id: 100, message: message() }, { update_id: NaN }]), code('INVALID_UPDATE'));
  assert.equal(f.store.collector('news').next_offset, 0); assert.equal(f.store.db.prepare('SELECT * FROM messages').all().length, 0);
});
test('an edited message is one row, and a delayed original cannot overwrite the edit', t => {
  const f = fixture(); t.after(() => f.store.close());
  f.store.saveMessage('news', message());
  f.store.saveMessage('news', { ...message(1, 'Edited'), edit_date: 1100 });
  f.store.saveMessage('news', message(1, 'Original'));
  const rows = f.runtime.messages({ target: 'community' }).messages;
  assert.equal(rows.length, 1); assert.equal(rows[0]!.text, 'Edited');
});
test('sync resumes the persisted offset and statistics never claim complete history', async t => {
  const f = fixture(); t.after(() => f.store.close());
  f.telegram.handler = (_b, method) => method === 'getWebhookInfo' ? { url: '' } : [{ update_id: 120, message: message() }];
  await f.runtime.sync('news'); await f.runtime.sync('news');
  assert.equal(f.telegram.calls[3]!.params.offset, 121);
  const stats = f.runtime.stats({ target: 'community' });
  assert.equal(stats.summary!.observed_messages, 1); assert.ok(stats.coverage[0]!.includes('not full Telegram history'));
});
test('message pagination/search is target-scoped and empty statistics return zero', t => {
  const f = fixture(); t.after(() => f.store.close());
  for (let i = 1; i <= 3; i++) f.store.saveMessage('news', message(i, `Text ${i}`, 1000 + i));
  const page = f.runtime.messages({ target: 'community', limit: 2 });
  assert.deepEqual(page.messages.map(m => m.message_id), [3, 2]);
  assert.deepEqual(f.runtime.messages({ target: 'community', before_message_id: page.next_before_message_id }).messages.map(m => m.message_id), [1]);
  assert.equal(f.runtime.messages({ target: 'community', query: 'Text 2' }).messages.length, 1);
  assert.equal(f.runtime.stats({ target: 'workroom' }).summary!.bot_messages, 0);
  assert.throws(() => f.runtime.message('workroom', 1), code('MESSAGE_NOT_ARCHIVED'));
});
test('local deletion preserves the archive with a deletion flag', async t => {
  const f = fixture(); t.after(() => f.store.close()); f.store.saveMessage('news', message());
  await f.runtime.write('community', 'request-delete', 'deleteMessage', { message_id: 1 });
  assert.equal(f.runtime.message('community', 1).deleted, true);
});
test('fetch exceptions and Telegram error descriptions cannot expose the bot token', async () => {
  const token = '123456:secretToken', bot: Bot = { alias: 'news', token_env: 'TG_NEWS', telegram_id: '123456', username: null };
  const broken = new Telegram({ TG_NEWS: token }, async () => { throw new Error(`URL https://api.telegram.org/bot${token}/sendMessage`); });
  await assert.rejects(broken.call(bot, 'sendMessage'), (e: unknown) => e instanceof Error && !e.message.includes(token));
  const rejected = new Telegram({ TG_NEWS: token }, async () => new Response(JSON.stringify({ ok: false, error_code: 400, description: `Invalid ${token}` }), { status: 400 }));
  await assert.rejects(rejected.call(bot, 'sendMessage'), (e: unknown) => e instanceof Error && !e.message.includes(token) && e.message.includes('[REDACTED]'));
});
test('missing credentials fail before a network call', async () => {
  const api = new Telegram({}, async () => { assert.fail('fetch must not run'); });
  await assert.rejects(api.call({ alias: 'bot', token_env: 'MISSING', telegram_id: '1', username: null }, 'sendMessage'), code('MISSING_TOKEN'));
});

test('unexpected write results cannot be recorded as successful', async t => {
  const f = fixture(); t.after(() => f.store.close());
  f.telegram.handler = () => true;
  await assert.rejects(f.runtime.write('community', 'request-bad-result', 'sendMessage', { text: 'Hello' }), code('TRANSPORT_UNKNOWN'));
  assert.equal(f.store.operation('request-bad-result')!.state, 'unknown');
  f.telegram.handler = () => message(50, 'Hello', 2000, -9999);
  await assert.rejects(f.runtime.write('community', 'request-bad-chat', 'sendMessage', { text: 'Hello' }), code('TRANSPORT_UNKNOWN'));
  assert.equal(f.store.operation('request-bad-chat')!.state, 'unknown');
  assert.equal(f.runtime.messages({ target: 'community' }).messages.length, 0);
});
test('arbitrary Telegram write methods are refused before any API call', async t => {
  const f = fixture(); t.after(() => f.store.close());
  await assert.rejects(f.runtime.write('community', 'request-unsupported', 'banChatMember', { user_id: 7 }), code('UNSUPPORTED_ACTION'));
  assert.equal(f.telegram.calls.length, 0);
});
