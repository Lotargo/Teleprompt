import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';

test('CLI accepts negative Telegram chat IDs as a separate argument', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teleprompt-cli-'));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../cli.js', import.meta.url)), 'chats', 'add', '--alias', 'test', '--bot', 'absent', '--chat-id', '-100123'], {
      cwd: dir, env: { ...process.env, TELEPROMPT_HOME: dir }, encoding: 'utf8'
    });
    const errorLine = result.stderr.split(/\r?\n/).find(line => line.startsWith('{'));
    assert.equal(result.status, 1); assert.equal(JSON.parse(errorLine!).code, 'BOT_NOT_FOUND');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('generated client configs use absolute shared paths and never serialize token values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teleprompt-cli-')), entry = fileURLToPath(new URL('../cli.js', import.meta.url));
  const store = new Store(join(dir, 'runtime.sqlite'));
  store.addBot({ alias: 'news', token_env: 'TG_NEWS', telegram_id: '100', username: null }); store.close();
  try {
    for (const client of ['codex', 'claude', 'opencode', 'opencode-v2']) {
      const result = spawnSync(process.execPath, [entry, 'config', '--client', client], { cwd: dir, env: { ...process.env, TELEPROMPT_HOME: dir, TG_NEWS: '123456:secretValue' }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr); assert.ok(!result.stdout.includes('secretValue'));
      if (client === 'codex') { assert.ok(result.stdout.includes('TG_NEWS')); assert.ok(result.stdout.includes('env_vars')); }
      else {
        const config = JSON.parse(result.stdout);
        const server = client === 'claude' ? config.mcpServers.teleprompt : client === 'opencode' ? config.mcp.teleprompt : config.mcp.servers.teleprompt;
        assert.equal(client === 'claude' ? server.env.TELEPROMPT_HOME : server.environment.TELEPROMPT_HOME, dir);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
