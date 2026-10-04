import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TelepromptError } from './types.js';

export class Secrets {
  private cached?: Buffer;
  constructor(private database: string) {}
  private key(): Buffer {
    if (this.cached) return this.cached;
    if (this.database === ':memory:') return this.cached = randomBytes(32);
    const path = join(dirname(this.database), 'credentials.key');
    try { this.cached = readFileSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new TelepromptError('CREDENTIAL_UNAVAILABLE', 'Cannot read the local credential key.');
      const key = randomBytes(32);
      try { writeFileSync(path, key, { flag: 'wx', mode: 0o600 }); this.cached = key; }
      catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw new TelepromptError('CREDENTIAL_UNAVAILABLE', 'Cannot create the local credential key.');
        this.cached = readFileSync(path);
      }
    }
    if (this.cached.length !== 32) throw new TelepromptError('CREDENTIAL_UNAVAILABLE', 'Invalid local credential key; restore its original file.');
    return this.cached;
  }
  encrypt(token: string, identity: string): string {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(), nonce);
    cipher.setAAD(Buffer.from(identity));
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  decrypt(value: string, identity: string): string {
    try {
      const data = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', this.key(), data.subarray(0, 12));
      cipher.setAAD(Buffer.from(identity)); cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
    } catch { throw new TelepromptError('CREDENTIAL_UNAVAILABLE', 'Cannot decrypt the saved bot token; restore the credential key or replace the token.'); }
  }
}
