import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp.js';
import { Runtime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { type Bot, type TelegramTransport } from '../src/types.js';
import { resolveWorkspace } from '../src/workspace.js';

test('MCP tools advertise writes accurately, validate inputs, and route publication', async t => {
  const store = new Store(':memory:');
  store.addBot({ alias: 'news', token_env: 'TG_NEWS', telegram_id: '100', username: null });
  store.addTarget({ alias: 'community', bot_alias: 'news', chat_id: '-100123', writable: 1 });
  store.setPolicy('test-all', { mode: 'all', rules: [], manage: true, description: 'Test fixture' });
  store.bind(resolveWorkspace(), 'test-all');
  let calls = 0;
  const telegram: TelegramTransport = { async call<T>(_bot: Bot, _method: string, params?: Record<string, unknown>) {
    calls++; return { message_id: 77, date: 1000, chat: { id: Number(params!.chat_id), type: 'supergroup' }, text: params!.text } as T;
  }};
  const server = createServer(new Runtime(store, telegram)), client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); store.close(); });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 27);
  assert.equal(tools.find(x => x.name === 'telegram_send_text')!.annotations!.readOnlyHint, false);
  assert.equal(tools.find(x => x.name === 'telegram_delete_message')!.annotations!.destructiveHint, true);
  assert.equal(tools.find(x => x.name === 'telegram_sync')!.annotations!.readOnlyHint, false);
  const invalid = await client.callTool({ name: 'telegram_send_text', arguments: { target: 'community', text: 'Hello', request_id: 'short' } });
  assert.equal(invalid.isError, true); assert.equal(calls, 0);
  const sent = await client.callTool({ name: 'telegram_send_text', arguments: { target: 'community', text: 'Hello', request_id: 'test-mcp-send' } });
  assert.notEqual(sent.isError, true); assert.equal(calls, 1);
  const replay = await client.callTool({ name: 'telegram_send_text', arguments: { target: 'community', text: 'Hello', request_id: 'test-mcp-send' } });
  assert.notEqual(replay.isError, true); assert.equal(calls, 1);
});

test('bundled CLI works as real MCP stdio process with no node_modules from an unrelated cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'teleprompt-stdio-'));
  const entrypoint = join(dir, 'cli.mjs');
  copyFileSync(fileURLToPath(new URL('../cli.js', import.meta.url)), entrypoint);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [entrypoint, 'mcp'], cwd: dir,
    env: { ...process.env, TELEPROMPT_HOME: join(dir, 'data') } as Record<string, string>, stderr: 'pipe'
  });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'telegram_inventory', arguments: {} });
    assert.notEqual(result.isError, true);
    const content = result.content as { type: string; text: string }[];
    const inventory = JSON.parse(content[0]!.text);
    assert.deepEqual(inventory.bots, []); assert.deepEqual(inventory.targets, []);
    assert.equal(inventory.setup_required, true);
    assert.equal((await client.listTools()).tools.length, 27);
  } finally { await client.close(); await transport.close(); rmSync(dir, { recursive: true, force: true }); }
  assert.ok(!stderr.includes('LOCAL_ERROR'), stderr);
});

test('MCP client workspace root selects policy and changing roots revokes prior access', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'teleprompt-roots-')), first = join(dir, 'first'), second = join(dir, 'second');
  mkdirSync(first); mkdirSync(second);
  const store = new Store(':memory:');
  store.addBot({ alias: 'news', token_env: 'TG_NEWS', telegram_id: '100', username: null });
  store.addTarget({ alias: 'community', bot_alias: 'news', chat_id: '-100123', writable: 1 });
  store.setPolicy('first-only', { mode: 'selected', rules: [{ bot: 'news', target: 'community', read: true, write: false }], manage: false, description: 'First directory' });
  store.bind(resolveWorkspace(first), 'first-only');
  const transport: TelegramTransport = { async call<T>(): Promise<T> { throw new Error('No network expected'); } };
  const server = createServer(new Runtime(store, transport)), client = new Client({ name: 'roots-test', version: '1' }, { capabilities: { roots: { listChanged: true } } });
  let roots = [{ uri: pathToFileURL(first).href }];
  client.setRequestHandler(ListRootsRequestSchema, () => ({ roots }));
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const current = await client.callTool({ name: 'telegram_context', arguments: { workspace: second } });
  assert.notEqual(current.isError, true); assert.ok(JSON.stringify(current).includes('first-only'));
  const blocked = await client.callTool({ name: 'telegram_send_text', arguments: { target: 'community', text: 'Hello', request_id: 'roots-write-blocked', workspace: second } });
  assert.equal(blocked.isError, true); assert.ok(JSON.stringify(blocked).includes('PERMISSION_DENIED'));
  roots = [{ uri: pathToFileURL(second).href }]; await client.notification({ method: 'notifications/roots/list_changed' });
  const next = await client.callTool({ name: 'telegram_messages', arguments: { target: 'community' } });
  assert.equal(next.isError, true); assert.ok(JSON.stringify(next).includes('POLICY_REQUIRED'));
  roots = [{ uri: pathToFileURL(first).href }, { uri: pathToFileURL(second).href }]; await client.notification({ method: 'notifications/roots/list_changed' });
  const ambiguous = await client.callTool({ name: 'telegram_inventory', arguments: {} });
  assert.equal(ambiguous.isError, true); assert.ok(JSON.stringify(ambiguous).includes('WORKSPACE_REQUIRED'));
});
