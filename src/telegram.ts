import { TelepromptError, type Bot, type TelegramTransport } from './types.js';

export class TelegramApiError extends TelepromptError {
  constructor(code: number, description: string, retryAfter?: number) {
    super('TELEGRAM_REJECTED', description, { error_code: code, retry_after: retryAfter });
  }
}

export class Telegram implements TelegramTransport {
  constructor(private env: NodeJS.ProcessEnv = process.env, private fetcher: typeof fetch = fetch, private tokenResolver?: (bot: Bot) => string | undefined) {}
  async call<T>(bot: Bot, method: string, params: Record<string, unknown> = {}, signal?: AbortSignal, tokenOverride?: string): Promise<T> {
    const token = tokenOverride ?? this.tokenResolver?.(bot) ?? this.env[bot.token_env];
    if (!token) throw new TelepromptError('MISSING_TOKEN', 'Configure a saved bot token or its environment variable before starting the runtime.');
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new TelepromptError('INVALID_TOKEN', 'Invalid bot token format.');
    const timeout = Number(params.timeout || 0) * 1000 + 15_000;
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: combined
      });
      const body = await response.json() as { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
      if (body.ok === false && typeof body.error_code === 'number') {
        throw new TelegramApiError(body.error_code, (body.description || 'Telegram rejected the request').replaceAll(token, '[REDACTED]'), body.parameters?.retry_after);
      }
      if (!response.ok || body.ok !== true || body.result === undefined) throw new TelepromptError('TRANSPORT_UNKNOWN', 'Telegram returned an unverified response; a write may have succeeded.');
      return body.result;
    } catch (error) {
      if (error instanceof TelepromptError) throw error;
      // Fetch errors may contain a complete URL, which embeds the bot token.
      throw new TelepromptError('TRANSPORT_UNKNOWN', 'Telegram response unavailable; a write may have succeeded. No automatic write retry.');
    }
  }
}
