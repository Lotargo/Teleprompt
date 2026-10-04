#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { Store, dataHome } from './src/store.js';
import { Runtime } from './src/runtime.js';
import { resolveWorkspace } from './src/workspace.js';
import { Telegram } from './src/telegram.js';
import { serve } from './src/mcp.js';
import { TelepromptError, policyInput, textInput, editInput, messageInput, mediaInput } from './src/types.js';

const help = `Teleprompt 0.2.0 — Telegram runtime with workspace policies (Node >=22.13)

teleprompt init
teleprompt init --allow-all --manage [--policy development]
teleprompt bots list
teleprompt bots add --alias news --token-stdin --description "Purpose of bot"
teleprompt bots add --alias news --token-env TELEGRAM_NEWS_TOKEN [--name "Display name"]
teleprompt bots update --alias news [--name "Name"] [--description "Purpose"] [--token-stdin]
teleprompt chats list
teleprompt chats add --alias community --bot news --chat-id @public_channel [--write] [--description "Audience and purpose"]
teleprompt chats update --alias community [--name "Name"] [--description "Purpose"]
teleprompt chats access --alias community --write | --read-only
teleprompt policies current|list
teleprompt policies configure --policy project --mode selected --allow community --access write
teleprompt policies set --policy project --mode deny --revision 1
teleprompt policies bind --policy project --directory ABSOLUTE-DIRECTORY
teleprompt policies unbind --scope SCOPE-KEY --policy project
teleprompt policies delete --policy project --revision 1
teleprompt inspect --target community
teleprompt sync --bot news
teleprompt watch [--bot news]
teleprompt messages --target community [--query word] [--limit 30] [--before 123]
teleprompt stats --target community [--since ISO] [--until ISO]
teleprompt send --target community --text "Text" --request-id UNIQUE-ID [--thread 123]
teleprompt edit --target community --message-id 123 --text "Text" --request-id UNIQUE-ID
teleprompt photo|document --target community --media HTTPS-URL-OR-FILE-ID --request-id UNIQUE-ID [--caption Text]
teleprompt delete|pin|unpin --target community --message-id 123 --request-id UNIQUE-ID
teleprompt audit
teleprompt config --client codex|claude|opencode|opencode-v2
teleprompt mcp

Data: per-user application directory, independent of cwd; override with absolute TELEPROMPT_HOME.
Tokens: encrypted in the local database; input via MCP or stdin, with optional environment references.
Workspace: client MCP root, otherwise launch cwd; TELEPROMPT_WORKSPACE can explicitly select the launch context.
No policy means data access is blocked until human-authorized setup. Non-Git directories match exactly.
--admin is the local owner's override for configuration/collection only; it cannot bypass publication policies.
watch owns the update stream: do not use the same bot with another getUpdates consumer.
`;

async function main() {
  // Telegram group IDs are negative; parseArgs otherwise treats them as options.
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--chat-id' && /^-\d+$/.test(args[i + 1]!)) args.splice(i, 2, `--chat-id=${args[i + 1]}`);
  }
  const { positionals, values: v } = parseArgs({ args, allowPositionals: true, options: {
    alias: { type: 'string' }, 'token-env': { type: 'string' }, 'token-stdin': { type: 'boolean' }, name: { type: 'string' }, description: { type: 'string' }, bot: { type: 'string' }, 'chat-id': { type: 'string' },
    'allow-all': { type: 'boolean' }, manage: { type: 'boolean' }, admin: { type: 'boolean' }, policy: { type: 'string' }, mode: { type: 'string' }, allow: { type: 'string', multiple: true }, access: { type: 'string' }, revision: { type: 'string' }, directory: { type: 'string' }, scope: { type: 'string' },
    write: { type: 'boolean' }, 'read-only': { type: 'boolean' }, target: { type: 'string' },
    query: { type: 'string' }, limit: { type: 'string' }, before: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' },
    text: { type: 'string' }, 'request-id': { type: 'string' }, 'message-id': { type: 'string' }, thread: { type: 'string' },
    'parse-mode': { type: 'string' }, client: { type: 'string' }, media: { type: 'string' }, caption: { type: 'string' }, help: { type: 'boolean', short: 'h' }
  }});
  const [command, sub] = positionals;
  if (!command || v.help || command === 'help') { process.stdout.write(help); return; }
  if (v.admin && !['init', 'bots', 'chats', 'policies', 'watch', 'sync'].includes(command)) throw new TelepromptError('ADMIN_NOT_ALLOWED', '--admin is allowed only for local configuration and collection; never for MCP or data/publication tools.');
  const home = dataHome(), store = new Store(join(home, 'runtime.sqlite'));
  const runtime = new Runtime(store, new Telegram(process.env, fetch, b => store.savedToken(b.alias)), resolveWorkspace(), Boolean(v.admin));
  const required = (key: keyof typeof v): string => {
    const value = v[key];
    if (typeof value !== 'string' || !value) throw new TelepromptError('ARGUMENT_REQUIRED', `Missing --${key}`);
    return value;
  };
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const metadata = { display_name: v.name, description: v.description };
  const readToken = async () => {
    const reader = createInterface({ input: process.stdin, terminal: false });
    try { for await (const line of reader) return line.trim(); }
    finally { reader.close(); process.stdin.pause(); }
    throw new TelepromptError('TOKEN_REQUIRED', 'Provide one token line on stdin.');
  };
  const policyValue = () => {
    if (v.access && !['read', 'write'].includes(v.access)) throw new TelepromptError('INVALID_ACCESS', 'Use --access read or write.');
    return policyInput.parse({ mode: required('mode'), manage: Boolean(v.manage), description: v.description || '', rules: (v.allow || []).map(name => ({ target: name, bot: store.target(name).bot_alias, read: true, write: v.access === 'write' })) });
  };
  try {
    switch (command) {
      case 'init':
        if (v['allow-all']) runtime.configurePolicy(v.policy || `workspace-${createHash('sha256').update(runtime.workspace.key).digest('hex').slice(0, 12)}`, { mode: 'all', rules: [], manage: Boolean(v.manage), description: v.description || '' }, v.revision ? Number(v.revision) : undefined);
        print({ home, database: store.path, ...runtime.inventory() }); break;
      case 'bots':
        if (sub === 'list') print(runtime.inventory().bots);
        else if (sub === 'add') print(await runtime.registerBot({ alias: required('alias'), token: v['token-stdin'] ? await readToken() : undefined, token_env: v['token-env'], ...metadata }));
        else if (sub === 'update') print(await runtime.updateBot(required('alias'), { ...metadata, token: v['token-stdin'] ? await readToken() : undefined }));
        else throw new TelepromptError('UNKNOWN_COMMAND', 'Use bots add, update or list.');
        break;
      case 'chats':
        if (sub === 'list') print(runtime.inventory().targets);
        else if (sub === 'add') print(await runtime.addTarget(required('alias'), required('bot'), required('chat-id'), Boolean(v.write), metadata));
        else if (sub === 'update') print(runtime.updateTarget(required('alias'), metadata));
        else if (sub === 'access') {
          if (Boolean(v.write) === Boolean(v['read-only'])) throw new TelepromptError('ARGUMENT_REQUIRED', 'Choose --write or --read-only.');
          print(runtime.updateTarget(required('alias'), { writable: Boolean(v.write) }));
        } else throw new TelepromptError('UNKNOWN_COMMAND', 'Use chats add, list or access.');
        break;
      case 'policies':
        if (sub === 'current') print(runtime.context());
        else if (sub === 'list') print(runtime.policies());
        else if (sub === 'configure') print(runtime.configurePolicy(required('policy'), policyValue(), v.revision ? Number(v.revision) : undefined));
        else if (sub === 'set') print(runtime.setPolicy(required('policy'), policyValue(), v.revision ? Number(v.revision) : undefined));
        else if (sub === 'bind') print(runtime.bindPolicy(required('directory'), required('policy')));
        else if (sub === 'unbind') print(runtime.unbindPolicy(required('scope'), required('policy')));
        else if (sub === 'delete') print(runtime.deletePolicy(required('policy'), Number(required('revision'))));
        else throw new TelepromptError('UNKNOWN_COMMAND', 'Use policies current, list, configure, set, bind, unbind or delete.');
        break;
      case 'inspect': print(await runtime.inspect(required('target'))); break;
      case 'sync': print(await runtime.sync(required('bot'))); break;
      case 'messages': print(runtime.messages({ target: required('target'), query: v.query, limit: v.limit ? Number(v.limit) : undefined, before_message_id: v.before ? Number(v.before) : undefined })); break;
      case 'stats': print(runtime.stats({ target: required('target'), since: v.since, until: v.until })); break;
      case 'audit': print(runtime.audit()); break;
      case 'send': {
        const a = textInput.parse({ target: required('target'), request_id: required('request-id'), text: required('text'), parse_mode: v['parse-mode'], thread_id: v.thread ? Number(v.thread) : undefined });
        print(await runtime.write(a.target, a.request_id, 'sendMessage', { text: a.text, parse_mode: a.parse_mode, message_thread_id: a.thread_id })); break;
      }
      case 'edit': {
        const a = editInput.parse({ target: required('target'), request_id: required('request-id'), message_id: Number(required('message-id')), text: required('text'), parse_mode: v['parse-mode'] });
        print(await runtime.write(a.target, a.request_id, 'editMessageText', { message_id: a.message_id, text: a.text, parse_mode: a.parse_mode })); break;
      }
      case 'photo': case 'document': {
        const a = mediaInput.parse({ target: required('target'), request_id: required('request-id'), media: required('media'), caption: v.caption, thread_id: v.thread ? Number(v.thread) : undefined });
        print(await runtime.write(a.target, a.request_id, command === 'photo' ? 'sendPhoto' : 'sendDocument', { [command]: a.media, caption: a.caption, message_thread_id: a.thread_id })); break;
      }
      case 'delete': case 'pin': case 'unpin': {
        const a = messageInput.parse({ target: required('target'), request_id: required('request-id'), message_id: Number(required('message-id')) });
        const method = { delete: 'deleteMessage', pin: 'pinChatMessage', unpin: 'unpinChatMessage' }[command];
        print(await runtime.write(a.target, a.request_id, method, { message_id: a.message_id, ...(command === 'pin' ? { disable_notification: true } : {}) })); break;
      }
      case 'config': {
        const client = required('client'), path = fileURLToPath(import.meta.url), executable = process.execPath;
        const entry = { command: executable, args: [path, 'mcp'], env: { TELEPROMPT_HOME: home } };
        if (client === 'codex') process.stdout.write(`[mcp_servers.teleprompt]\ncommand = ${JSON.stringify(executable)}\nargs = ${JSON.stringify(entry.args)}\nenv_vars = ${JSON.stringify(store.bots().map(b => b.token_env).filter(Boolean))}\n\n[mcp_servers.teleprompt.env]\nTELEPROMPT_HOME = ${JSON.stringify(home)}\n`);
        else if (client === 'claude') print({ mcpServers: { teleprompt: entry } });
        else if (client === 'opencode' || client === 'opencode-v2') {
          const server = { type: 'local', command: [executable, path, 'mcp'], environment: { TELEPROMPT_HOME: home }, ...(client === 'opencode' ? { enabled: true } : {}) };
          print({ mcp: client === 'opencode' ? { teleprompt: server } : { servers: { teleprompt: server } } });
        } else throw new TelepromptError('UNKNOWN_CLIENT', 'Use codex, claude, opencode or opencode-v2.');
        break;
      }
      case 'mcp': {
        const server = await serve(runtime);
        let closed = false;
        const close = async () => { if (closed) return; closed = true; await server.close(); store.close(); };
        process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
        process.stdin.once('end', () => void close());
        return;
      }
      case 'watch': {
        runtime.requireManage();
        const names = v.bot ? [store.bot(v.bot).alias] : store.bots().map(b => b.alias);
        if (!names.length) throw new TelepromptError('NO_BOTS', 'Add at least one bot before starting a collector.');
        const controller = new AbortController();
        process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
        const outcomes = await Promise.allSettled(names.map(async name => {
          let backoff = 1000;
          while (!controller.signal.aborted) {
            try { await runtime.sync(name, 20, controller.signal); backoff = 1000; }
            catch (error) {
              if (controller.signal.aborted) break;
              const code = error instanceof TelepromptError ? error.code : 'COLLECTOR_ERROR';
              process.stderr.write(JSON.stringify({ bot: name, error: code }) + '\n');
              if (['WEBHOOK_ACTIVE', 'MISSING_TOKEN', 'INVALID_TOKEN'].includes(code)) { controller.abort(); throw error; }
              const retry = error instanceof TelepromptError ? Number(error.details?.retry_after || 0) * 1000 : 0;
              backoff = Math.min(backoff * 2, 60_000);
              await delay(Math.max(backoff, retry), undefined, { signal: controller.signal }).catch(() => {});
            }
          }
        }));
        const failure = outcomes.find(outcome => outcome.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        break;
      }
      default: throw new TelepromptError('UNKNOWN_COMMAND', `Unknown command: ${command}. Run teleprompt --help.`);
    }
  } finally { if (command !== 'mcp') store.close(); }
}

main().catch(error => {
  const value = error instanceof TelepromptError ? { code: error.code, message: error.message, details: error.details } : error instanceof z.ZodError ? { code: 'INVALID_INPUT', issues: error.issues.map(i => ({ path: i.path, message: i.message })) } : { code: 'LOCAL_ERROR', message: 'Local operation failed. Check arguments, duplicate aliases and runtime file access.' };
  process.stderr.write(JSON.stringify(value) + '\n'); process.exitCode = 1;
});
