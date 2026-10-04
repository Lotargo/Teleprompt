import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Runtime } from '../src/runtime.js';
import { Telegram } from '../src/telegram.js';
import { normalizeRemote, resolveWorkspace, type Workspace } from '../src/workspace.js';
import { TelepromptError, type Bot, type PolicyInput, type TelegramTransport } from '../src/types.js';

const owner: Workspace = { key: 'git:example.com/owner', kind: 'git', directory: process.cwd(), repository_root: process.cwd(), label: 'owner' };
const restricted = { ...owner, key: 'git:example.com/restricted', label: 'restricted' };
const denied = { ...owner, key: 'git:example.com/denied', label: 'denied' };
const unknown = { ...owner, key: 'directory:unconfigured', kind: 'directory' as const };
const all: PolicyInput = { mode: 'all', rules: [], manage: true, description: 'Owner administration' };
const selected: PolicyInput = { mode: 'selected', rules: [{ bot: 'privatebot', target: 'private', read: true, write: true }], manage: false, description: 'Internal project only' };
const deny: PolicyInput = { mode: 'deny', rules: [], manage: false, description: 'No Telegram' };
const code = (expected: string) => (e: unknown) => e instanceof TelepromptError && e.code === expected;
function setup(path = ':memory:') {
  const store = new Store(path);
  store.addBot({ alias: 'privatebot', token_env: 'PRIVATE_TOKEN', telegram_id: '100', username: null, description: 'Internal communications' });
  store.addBot({ alias: 'publicbot', token_env: 'PUBLIC_TOKEN', telegram_id: '200', username: null, description: 'Public news bot' });
  store.addTarget({ alias: 'private', bot_alias: 'privatebot', chat_id: '-1001', writable: 1, description: 'Private engineering team' });
  store.addTarget({ alias: 'public', bot_alias: 'publicbot', chat_id: '-1002', writable: 1, description: 'Public audience; no internal project material' });
  store.setPolicy('owner', all); store.bind(owner, 'owner');
  store.setPolicy('restricted', selected); store.bind(restricted, 'restricted');
  store.setPolicy('denied', deny); store.bind(denied, 'denied');
  let calls = 0;
  const transport: TelegramTransport = { async call<T>(_bot: Bot, method: string, params: Record<string, unknown> = {}, _signal?: AbortSignal, token?: string): Promise<T> {
    calls++;
    if (method === 'getMe') return { id: Number(token?.split(':')[0] || _bot.telegram_id), is_bot: true, username: 'test_bot', first_name: 'Test bot' } as T;
    if (method === 'getChat') return { id: -1003, type: 'channel', title: 'Test channel', username: 'test_channel' } as T;
    return { message_id: 1, date: 1000, chat: { id: Number(params.chat_id), type: 'supergroup' }, text: params.text } as T;
  }};
  return { store, transport, calls: () => calls, runtime: new Runtime(store, transport, owner) };
}

test('selected policy prevents confidential publication to a public target before any API call', async t => {
  const f = setup(); t.after(() => f.store.close()); const runtime = new Runtime(f.store, f.transport, restricted);
  await assert.rejects(runtime.write('public', 'confidential-request', 'sendMessage', { text: 'Confidential' }), code('PERMISSION_DENIED'));
  assert.equal(f.calls(), 0); assert.equal(f.store.operation('confidential-request'), undefined);
  await runtime.write('private', 'authorized-request', 'sendMessage', { text: 'Internal update' }); assert.equal(f.calls(), 1);
  assert.deepEqual(runtime.inventory().targets.map(t => t.alias), ['private']);
});
test('deny policy and unbound directory block reads, writes and global collectors', async t => {
  const f = setup(); t.after(() => f.store.close());
  for (const [workspace, expected] of [[denied, 'PERMISSION_DENIED'], [unknown, 'POLICY_REQUIRED']] as const) {
    const runtime = new Runtime(f.store, f.transport, workspace);
    assert.throws(() => runtime.messages({ target: 'private' }), code(expected));
    assert.throws(() => runtime.stats({ target: 'private' }), code(expected));
    await assert.rejects(runtime.inspect('private'), code(expected));
    await assert.rejects(runtime.sync('privatebot'), code(expected));
    await assert.rejects(runtime.write('private', 'denied-publication', 'sendMessage', { text: 'Hello' }), code(expected));
  }
  assert.equal(f.calls(), 0); assert.deepEqual(new Runtime(f.store, f.transport, denied).inventory().targets, []);
  const setupInventory = new Runtime(f.store, f.transport, unknown).inventory();
  assert.equal(setupInventory.setup_required, true); assert.ok(setupInventory.targets.some(t => t.description!.includes('Public audience')));
  assert.equal(setupInventory.targets.every(t => !t.access.read && !t.access.write), true);
});
test('read-only policy cannot publish even when the chat globally permits writes', async t => {
  const f = setup(); t.after(() => f.store.close());
  f.runtime.setPolicy('restricted', { ...selected, rules: [{ bot: 'privatebot', target: 'private', read: true, write: false }] }, 1);
  const runtime = new Runtime(f.store, f.transport, restricted);
  assert.equal(runtime.messages({ target: 'private' }).messages.length, 0);
  await assert.rejects(runtime.write('private', 'read-only-request', 'sendMessage', { text: 'Hello' }), code('PERMISSION_DENIED'));
  assert.equal(f.calls(), 0);
});
test('audit and operation replay cannot expose results from forbidden chats', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.runtime.write('public', 'public-operation', 'sendMessage', { text: 'Public text' });
  await f.runtime.write('private', 'private-operation', 'sendMessage', { text: 'Private text' });
  const runtime = new Runtime(f.store, f.transport, restricted);
  assert.deepEqual(runtime.audit().map(r => r.target), ['private']);
  assert.throws(() => runtime.operation('public-operation'), code('PERMISSION_DENIED'));
  await assert.rejects(runtime.write('public', 'public-operation', 'sendMessage', { text: 'Public text' }), code('PERMISSION_DENIED'));
  assert.ok(JSON.stringify(runtime.operation('private-operation')).includes('Private text'));
});
test('restricted/denied workspaces cannot grant themselves management or alter bindings', t => {
  const f = setup(); t.after(() => f.store.close());
  const runtime = new Runtime(f.store, f.transport, restricted);
  assert.throws(() => runtime.configurePolicy('restricted', all, 1), code('ADMIN_REQUIRED'));
  assert.throws(() => runtime.setPolicy('owner', all, 1), code('ADMIN_REQUIRED'));
  assert.throws(() => runtime.unbindPolicy(restricted.key, 'restricted'), code('ADMIN_REQUIRED'));
  assert.throws(() => new Runtime(f.store, f.transport, denied).configurePolicy('denied', all, 1), code('PERMISSION_DENIED'));
  assert.equal(f.store.policy('restricted')!.manage, false);
});
test('unbound workspace can create its own policy but cannot overwrite an existing shared policy', t => {
  const f = setup(); t.after(() => f.store.close()); const runtime = new Runtime(f.store, f.transport, unknown);
  assert.throws(() => runtime.configurePolicy('owner', all, 1), code('ADMIN_REQUIRED'));
  runtime.configurePolicy('new-directory', selected);
  assert.equal(runtime.context().policy!.id, 'new-directory'); assert.equal(runtime.messages({ target: 'private' }).messages.length, 0);
});
test('policy edits, deletion and unbinding take effect in an already running session', async t => {
  const f = setup(); t.after(() => f.store.close()); const runtime = new Runtime(f.store, f.transport, restricted);
  f.runtime.setPolicy('restricted', deny, 1);
  await assert.rejects(runtime.write('private', 'revoked-request', 'sendMessage', { text: 'Hello' }), code('PERMISSION_DENIED'));
  f.runtime.deletePolicy('restricted', 2);
  assert.equal(runtime.context().setup_required, true);
  assert.throws(() => runtime.messages({ target: 'private' }), code('POLICY_REQUIRED'));
  f.runtime.unbindPolicy(denied.key, 'denied'); assert.equal(new Runtime(f.store, f.transport, denied).context().setup_required, true);
});
test('policy revision conflicts and wrong bot+chat pairs cannot overwrite permissions', t => {
  const f = setup(); t.after(() => f.store.close());
  assert.throws(() => f.runtime.setPolicy('restricted', deny), code('REVISION_REQUIRED'));
  assert.throws(() => f.runtime.setPolicy('restricted', deny, 7), code('POLICY_CONFLICT'));
  assert.throws(() => f.runtime.setPolicy('restricted', { ...selected, rules: [{ bot: 'publicbot', target: 'private', read: true, write: true }] }, 1), code('POLICY_PAIR_MISMATCH'));
  assert.equal(f.store.policy('restricted')!.revision, 1);
});
test('Git transport variants share identity, distinct repositories do not, and non-Git directories match exactly', t => {
  assert.equal(normalizeRemote('git@github.com:Lotargo/Teleprompt.git'), 'github.com/lotargo/teleprompt');
  assert.equal(normalizeRemote('https://user:password@github.com/Lotargo/Teleprompt.git?token=fake'), 'github.com/lotargo/teleprompt');
  const dir = mkdtempSync(join(tmpdir(), 'teleprompt-scope-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = join(dir, 'a'), b = join(dir, 'b'), plain = join(dir, 'plain'), nested = join(plain, 'nested');
  for (const path of [a, b, plain, nested]) mkdirSync(path, { recursive: true });
  for (const [path, remote] of [[a, 'https://github.com/Lotargo/Teleprompt.git'], [b, 'git@github.com:Lotargo/Teleprompt.git']]) {
    execFileSync('git', ['init', '--quiet', path!], { stdio: 'ignore' });
    execFileSync('git', ['-C', path!, 'remote', 'add', 'origin', remote!], { stdio: 'ignore' });
  }
  mkdirSync(join(a, 'sub')); assert.equal(resolveWorkspace(join(a, 'sub')).key, resolveWorkspace(a).key);
  assert.equal(resolveWorkspace(a).key, resolveWorkspace(b).key);
  execFileSync('git', ['-C', b, 'remote', 'set-url', 'origin', 'https://github.com/Lotargo/Other.git'], { stdio: 'ignore' });
  assert.notEqual(resolveWorkspace(a).key, resolveWorkspace(b).key);
  const f = setup(); t.after(() => f.store.close());
  f.runtime.bindPolicy(plain, 'restricted');
  assert.equal(new Runtime(f.store, f.transport, resolveWorkspace(plain)).context().policy!.id, 'restricted');
  assert.equal(new Runtime(f.store, f.transport, resolveWorkspace(nested)).context().setup_required, true);
});
test('saved token is encrypted, survives restart, and is usable without environment credentials', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'teleprompt-secrets-'));
  const path = join(dir, 'db.sqlite'), f = setup(path), token = '300:secretToken';
  let reopened: Store | undefined;
  let firstClosed = false;
  t.after(() => { if (!firstClosed) f.store.close(); reopened?.close(); rmSync(dir, { recursive: true, force: true }); });
  const registered = await f.runtime.registerBot({ alias: 'saved', token, description: 'Bot saved from human chat or a read file' });
  assert.equal(registered.credential_kind, 'local'); assert.ok(!JSON.stringify(registered).includes(token));
  assert.ok(!JSON.stringify(f.runtime.inventory()).includes(token));
  assert.ok(!String(f.store.db.prepare('SELECT ciphertext FROM bot_secrets').get()!.ciphertext).includes(token));
  f.store.close(); firstClosed = true; assert.ok(!readFileSync(path).includes(Buffer.from(token)));
  reopened = new Store(path);
  let authenticated = false;
  const api = new Telegram({}, async (url) => { authenticated = String(url).includes(`/bot${token}/getMe`); return new Response(JSON.stringify({ ok: true, result: { id: 300, is_bot: true } })); }, b => reopened!.savedToken(b.alias));
  await api.call(reopened.bot('saved'), 'getMe'); assert.equal(authenticated, true);
});
test('bot token rotation preserves identity and profile descriptions can be edited', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.runtime.updateBot('privatebot', { token: '100:newSecret', description: 'Updated internal bot', display_name: 'Team bot' });
  assert.equal(f.store.savedToken('privatebot'), '100:newSecret');
  await assert.rejects(f.runtime.updateBot('privatebot', { token: '999:otherBot' }), code('BOT_IDENTITY_MISMATCH'));
  assert.equal(f.store.savedToken('privatebot'), '100:newSecret');
  f.runtime.updateTarget('private', { description: 'Engineering only', display_name: 'Engineers' });
  assert.equal(f.store.target('private').description, 'Engineering only');
});
test('public chat link resolves once and the runtime stores a numeric routing identity', async t => {
  const f = setup(); t.after(() => f.store.close());
  const added = await f.runtime.addTarget('test-channel', 'privatebot', 'https://t.me/test_channel', true, { description: 'Acceptance channel' });
  assert.equal(added.target.chat_id, '-1003'); assert.equal(added.target.display_name, 'Test channel'); assert.equal(added.target.username, 'test_channel');
});
test('version 1 migration preserves profiles while creating no implicit workspace grants', t => {
  const dir = mkdtempSync(join(tmpdir(), 'teleprompt-migration-'));
  const path = join(dir, 'db.sqlite'), old = new DatabaseSync(path);
  old.exec("CREATE TABLE bots(alias TEXT PRIMARY KEY,token_env TEXT NOT NULL,telegram_id TEXT NOT NULL UNIQUE,username TEXT); CREATE TABLE targets(alias TEXT PRIMARY KEY,bot_alias TEXT NOT NULL REFERENCES bots(alias),chat_id TEXT NOT NULL,writable INTEGER NOT NULL DEFAULT 0,UNIQUE(bot_alias,chat_id)); INSERT INTO bots VALUES('legacy','LEGACY_TOKEN','100',NULL); INSERT INTO targets VALUES('legacy-chat','legacy','-1001',1); PRAGMA user_version=1;"); old.close();
  const store = new Store(path); t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(store.bot('legacy').token_env, 'LEGACY_TOKEN'); assert.equal(store.target('legacy-chat').chat_id, '-1001');
  assert.equal(store.currentPolicy(owner), undefined); assert.equal(Number(store.db.prepare('PRAGMA user_version').get()!.user_version), 2);
});
