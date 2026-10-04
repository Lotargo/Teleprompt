import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { TelepromptError } from './types.js';

export interface Workspace {
  key: string; kind: 'git' | 'directory'; directory: string; repository_root: string | null; label: string;
}
function canonicalPath(path: string) {
  const value = realpathSync.native(resolve(path)).replaceAll('\\', '/').replace(/\/$/, '');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
export function normalizeRemote(remote: string): string | null {
  let url: URL;
  try {
    const ssh = remote.match(/^(?:[^/@:]+@)?([^/:]+):(.+)$/);
    url = new URL(!remote.includes('://') && ssh ? `ssh://${ssh[1]}/${ssh[2]}` : remote);
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname) return null;
  } catch { return null; }
  const host = url.hostname.toLowerCase();
  let path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!path) return null;
  if (host === 'github.com') path = path.toLowerCase();
  const port = url.port && !['22', '80', '443', '9418'].includes(url.port) ? `:${url.port}` : '';
  // Credentials, URL queries and fragments never become an identity or output.
  return `${host}${port}/${path}`;
}
export function resolveWorkspace(directory: string = process.env.TELEPROMPT_WORKSPACE || process.cwd()): Workspace {
  if (!isAbsolute(directory) || !existsSync(directory)) throw new TelepromptError('INVALID_WORKSPACE', 'Workspace must be an existing absolute directory.');
  const path = canonicalPath(directory);
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  let root: string;
  try { root = canonicalPath(git('rev-parse', '--show-toplevel')); }
  catch { return { key: `directory:${path}`, kind: 'directory', directory: path, repository_root: null, label: basename(path) || path }; }
  let remote: string | null = null;
  try { remote = normalizeRemote(git('remote', 'get-url', 'origin')); } catch { /* no origin */ }
  let common: string;
  try { common = canonicalPath(git('rev-parse', '--path-format=absolute', '--git-common-dir')); }
  catch { common = root; }
  return { key: remote ? `git:${remote}` : `git-local:${common}`, kind: 'git', directory: path, repository_root: root, label: basename(root) };
}
