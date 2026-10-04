import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Explicitly invoked live test: publishes one temporary message to the supplied
// target, edits/pins/unpins it, and deletes only artifacts owned by this run.
const { values } = parseArgs({ options: {
  target: { type: 'string' }, bot: { type: 'string' }, workspace: { type: 'string' }, output: { type: 'string' }
}});
assert.ok(values.target && values.bot, 'Supply --target and --bot for an authorized test destination.');
const workspace = resolve(values.workspace || process.cwd());
const run = `live-${randomUUID()}`;
const output = resolve(values.output || `.teleprompt/${run}.json`);
const outside = mkdtempSync(resolve(tmpdir(), 'teleprompt-live-context-'));
const env = { ...process.env };
delete env.TELEPROMPT_WORKSPACE;
const transport = new StdioClientTransport({
  command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'mcp'],
  cwd: outside, env, stderr: 'pipe'
});
transport.stderr?.on('data', () => {});
const client = new Client({ name: 'teleprompt-live-acceptance', version: '0.2.0' }, { capabilities: { roots: { listChanged: true } } });
let roots = [{ uri: pathToFileURL(workspace).href }];
client.setRequestHandler(ListRootsRequestSchema, () => ({ roots }));
const report = { run, started_at: new Date().toISOString(), target: values.target, bot: values.bot, workspace, checks: [], operations: [], cleanup: {} };
let messageId, deleteAttempted = false;
const ownedServices = [];

async function raw(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content.find(item => item.type === 'text')?.text;
  assert.ok(text, `Missing JSON response for ${name}`);
  return { error: response.isError === true, value: JSON.parse(text) };
}
async function call(name, args = {}) {
  const result = await raw(name, args);
  if (result.error) throw Object.assign(new Error(`${name}: ${result.value.code}`), { code: result.value.code });
  return result.value;
}
function pass(name, evidence) {
  report.checks.push({ name, status: 'PASS', evidence });
  console.log(`PASS ${name}`);
}
async function write(name, action, args = {}) {
  const request_id = `${run}-${action}`;
  const result = await call(name, { target: values.target, request_id, ...args });
  assert.equal(result.state, 'succeeded');
  report.operations.push({ request_id, action, replayed: result.replayed, state: result.state });
  return result;
}
async function setRoot(directory) {
  roots = [{ uri: pathToFileURL(directory).href }];
  await client.notification({ method: 'notifications/roots/list_changed' });
}
async function removeOwnedMessage() {
  if (!messageId || deleteAttempted) return;
  deleteAttempted = true;
  await write('telegram_delete_message', 'delete', { message_id: messageId });
  report.cleanup.message_deleted = true;
}

try {
  await client.connect(transport);
  const context = await call('telegram_context');
  assert.equal(context.setup_required, false);
  report.scope = context.workspace?.key;
  pass('mcp_workspace_policy', { context, tool_count: (await client.listTools()).tools.length });
  const before = await call('telegram_inspect_chat', { target: values.target });
  assert.equal(before.target.bot_alias, values.bot);
  assert.equal(before.bot_membership.status, 'administrator');
  report.chat_id = before.target.chat_id;
  report.cleanup.previous_pin = before.chat.pinned_message?.message_id || null;
  pass('live_inspection', { username: before.chat.username, member_count: before.member_count_now, bot_status: before.bot_membership.status });
  const text = `Teleprompt: технический тест публикации.\n${run}\nЭто сообщение будет отредактировано и удалено после проверки.`;
  const sent = await write('telegram_send_text', 'send', { text });
  messageId = sent.result.message_id;
  report.message_id = messageId;
  assert.equal(String(sent.result.chat.id), report.chat_id);
  pass('send', { message_id: messageId });
  const replay = await call('telegram_send_text', { target: values.target, text, request_id: `${run}-send` });
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.message_id, messageId);
  pass('replay', { replayed: true, same_message_id: messageId });
  const conflict = await raw('telegram_send_text', { target: values.target, text: `${text}\nДругой текст`, request_id: `${run}-send` });
  assert.equal(conflict.error, true);
  assert.equal(conflict.value.code, 'IDEMPOTENCY_CONFLICT');
  pass('request_id_conflict', { code: conflict.value.code });
  const editedText = `Teleprompt: технический тест — текст успешно изменён.\n${run}\nПосле проверки сообщение будет удалено.`;
  const edited = await write('telegram_edit_text', 'edit', { message_id: messageId, text: editedText });
  assert.equal(edited.result.text, editedText);
  const archived = await call('telegram_message', { target: values.target, message_id: messageId });
  assert.equal(archived.message.text, editedText);
  pass('edit_and_archive', { message_id: messageId, edit_date: edited.result.edit_date });
  await write('telegram_pin_message', 'pin', { message_id: messageId });
  const pinState = await call('telegram_inspect_chat', { target: values.target });
  assert.equal(pinState.chat.pinned_message?.message_id, messageId);
  pass('pin', { verified_by_getChat: messageId });
  await write('telegram_unpin_message', 'unpin', { message_id: messageId });
  const unpinState = await call('telegram_inspect_chat', { target: values.target });
  assert.equal(unpinState.chat.pinned_message?.message_id || null, report.cleanup.previous_pin);
  pass('unpin', { restored_previous_pin: report.cleanup.previous_pin });
  const sync = await call('telegram_sync', { bot: values.bot });
  pass('collector_sync', sync);
  const messages = await call('telegram_messages', { target: values.target, query: run });
  assert.equal(messages.messages.length, 1);
  assert.equal(messages.messages[0].text, editedText);
  pass('archive_search', { matching_messages: messages.messages.length, message_id: messages.messages[0].message_id });
  // Telegram may create a service notification when pinning. Only remove one
  // whose embedded pinned_message identifies this run's own message.
  const recent = await call('telegram_messages', { target: values.target, limit: 100 });
  for (const row of recent.messages.filter(row => row.message_id > messageId)) {
    const item = await call('telegram_message', { target: values.target, message_id: row.message_id });
    if (item.message.pinned_message?.message_id === messageId) ownedServices.push(row.message_id);
  }
  await setRoot(outside);
  const blockedId = `${run}-blocked`;
  const blocked = await raw('telegram_send_text', { target: values.target, text: `Teleprompt: проверка запрета ${run}`, request_id: blockedId });
  assert.equal(blocked.error, true);
  assert.equal(blocked.value.code, 'POLICY_REQUIRED');
  const blockedRead = await raw('telegram_messages', { target: values.target });
  assert.equal(blockedRead.error, true);
  assert.equal(blockedRead.value.code, 'POLICY_REQUIRED');
  await setRoot(workspace);
  const absent = await raw('telegram_operation', { request_id: blockedId });
  assert.equal(absent.error, true);
  assert.equal(absent.value.code, 'OPERATION_NOT_FOUND');
  pass('unconfigured_directory_blocked', { send: blocked.value.code, read: blockedRead.value.code, operation: absent.value.code });
  await removeOwnedMessage();
  const deleted = await call('telegram_message', { target: values.target, message_id: messageId });
  assert.equal(deleted.deleted, true);
  pass('delete_and_tombstone', { message_id: messageId, deleted: true });
  for (const serviceId of ownedServices) {
    await write('telegram_delete_message', `delete-service-${serviceId}`, { message_id: serviceId });
  }
  report.cleanup.deleted_service_messages = ownedServices;
  const stats = await call('telegram_stats', { target: values.target });
  assert.ok(stats.summary.observed_messages >= 1);
  assert.ok(stats.summary.locally_deleted_messages >= 1);
  assert.ok(stats.coverage.length > 0);
  pass('partial_archive_statistics', { summary: stats.summary, coverage: stats.coverage });
  const audit = await call('telegram_audit', { limit: 100 });
  const own = audit.filter(item => item.request_id.startsWith(run));
  assert.equal(own.length, report.operations.length);
  assert.ok(own.every(item => item.state === 'succeeded'));
  pass('persistent_audit', { operations: own });
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.failure = { code: error.code || 'ASSERTION_OR_LOCAL_FAILURE', message: error.message };
  console.error(`FAIL ${report.failure.message}`);
  process.exitCode = 1;
} finally {
  try {
    await setRoot(workspace);
    // Delete is a separate cleanup action. Never repeat a failed/unknown pin,
    // unpin or delete with a new request_id after an interrupted test.
    await removeOwnedMessage();
  } catch (error) {
    report.cleanup.error = { code: error.code || 'LOCAL_FAILURE', message: error.message };
    report.status = 'FAIL';
    process.exitCode = 1;
  }
  await client.close();
  await transport.close();
  rmdirSync(outside); // Empty directory owned by this run; no recursive removal.
  report.finished_at = new Date().toISOString();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${output}`);
}
