import { z } from 'zod';

export const alias = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const tokenEnv = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/);
export const botToken = z.string().regex(/^\d+:[A-Za-z0-9_-]+$/).max(256);
export const description = z.string().max(4000);
export const displayName = z.string().min(1).max(200);
export const policyRule = z.object({ bot: alias, target: alias, read: z.boolean().default(true), write: z.boolean().default(false) });
export const policyInput = z.object({ mode: z.enum(['all', 'selected', 'deny']), rules: z.array(policyRule).max(1000).default([]), manage: z.boolean().default(false), description: description.default('') }).superRefine((p, ctx) => {
  if (p.mode !== 'selected' && p.rules.length) ctx.addIssue({ code: 'custom', message: 'Only selected policies accept rules.' });
  if (p.mode === 'selected' && !p.rules.length) ctx.addIssue({ code: 'custom', message: 'Selected policies require an explicit bot/target rule.' });
  if (p.mode === 'deny' && p.manage) ctx.addIssue({ code: 'custom', message: 'Deny policies cannot administer the runtime.' });
  if (p.rules.some(r => r.write && !r.read)) ctx.addIssue({ code: 'custom', message: 'Write access also requires read access.' });
});
export type PolicyInput = z.infer<typeof policyInput>;
export interface Policy extends PolicyInput { id: string; revision: number; updated_at: number }
export const chatId = z.string().regex(/^-?[1-9][0-9]*$/).refine(v => Number.isSafeInteger(Number(v)), 'Chat ID must be a safe integer');
export const targetInput = z.object({ target: alias });
export const writeInput = targetInput.extend({ request_id: z.string().min(8).max(128) });
export const textInput = writeInput.extend({ text: z.string().min(1).max(4096), parse_mode: z.enum(['HTML', 'MarkdownV2']).optional(), thread_id: z.number().int().positive().optional() });
export const messageInput = writeInput.extend({ message_id: z.number().int().positive() });
export const editInput = messageInput.extend({ text: z.string().min(1).max(4096), parse_mode: z.enum(['HTML', 'MarkdownV2']).optional() });
export const mediaInput = writeInput.extend({ media: z.string().min(1).max(2048).refine(v => /^[A-Za-z0-9_-]+$/.test(v) || /^https:\/\//.test(v), 'Use a Telegram file_id or HTTPS URL'), caption: z.string().max(1024).optional(), thread_id: z.number().int().positive().optional() });
export const messagesInput = targetInput.extend({ query: z.string().max(500).optional(), before_message_id: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(30) });
export const statsInput = targetInput.extend({ since: z.string().datetime({ offset: true }).optional(), until: z.string().datetime({ offset: true }).optional() });

export interface Bot { alias: string; token_env: string; telegram_id: string; username: string | null; display_name?: string; description?: string; credential_kind?: 'local' | 'environment' }
export interface Target { alias: string; bot_alias: string; chat_id: string; writable: number; display_name?: string; description?: string; username?: string | null }
export interface TgMessage {
  message_id: number; date: number; edit_date?: number;
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
  sender_chat?: { id: number; title?: string }; text?: string; caption?: string;
  message_thread_id?: number; [key: string]: unknown;
}
export interface Update { update_id: number; message?: TgMessage; edited_message?: TgMessage; channel_post?: TgMessage; edited_channel_post?: TgMessage; [key: string]: unknown }
export interface TelegramTransport { call<T = unknown>(bot: Bot, method: string, params?: Record<string, unknown>, signal?: AbortSignal, tokenOverride?: string): Promise<T> }
export class TelepromptError extends Error {
  constructor(public code: string, message: string, public details?: Record<string, unknown>) { super(message); }
}
export const coverageNotice = [
  'Archive contains only messages observed by this bot or sent through Teleprompt; it is not full Telegram history.',
  'Visibility depends on bot membership, administrator rights and privacy mode. Messages from other bots are generally unavailable.',
  'Telegram retains unconsumed updates for at most 24 hours; downtime and other update consumers can create gaps.',
  'External deletions, channel views and full membership history are not tracked by this Bot API archive.'
];
