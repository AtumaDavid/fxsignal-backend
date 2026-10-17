import { createHmac, randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { prisma } from './prisma.js';

// ---- External alert channels: Telegram, Discord, webhooks ----------------------
//
// Telegram needs TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME (a free bot from
// @BotFather). Users link their chat by opening a one-time deep link; the
// server reads the bot's updates once a minute (no public webhook needed).
// Discord and generic webhooks are user-supplied HTTPS URLs; requests only
// ever connect to public addresses (checked at connect time, so a DNS change
// cannot point them at internal services), and webhooks are HMAC-signed.

export interface AlertTargets {
  telegramChatId?: string | null;
  telegramLinkCode?: string | null;
  /** ms */
  telegramLinkExpires?: number | null;
  discordWebhookUrl?: string | null;
  webhookUrl?: string | null;
  /** HMAC-SHA256 key for the X-FXSignal-Signature header. */
  webhookSecret?: string | null;
}

export function readAlertTargets(value: unknown): AlertTargets {
  return typeof value === 'object' && value !== null ? (value as AlertTargets) : {};
}

export function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_USERNAME);
}

// ---- Safe outbound requests ---------------------------------------------------------

/** Loopback, private, link-local, CGNAT, multicast and reserved ranges. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe8') ||
    v6.startsWith('fe9') ||
    v6.startsWith('fea') ||
    v6.startsWith('feb') ||
    v6.startsWith('ff')
  );
}

/** DNS lookup that refuses to connect to a non-public address. */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: false }, (error, address, family) => {
    if (error) return callback(error, address, family);
    if (typeof address === 'string' && isPrivateAddress(address))
      return callback(new Error(`Refusing to connect to a private address for ${hostname}.`), address, family);
    callback(null, address, family);
  });
};

/** Why a user-supplied URL is not allowed, or null when it is. */
export function urlProblem(raw: string, kind: 'discord' | 'webhook'): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Not a valid URL.';
  }
  if (url.protocol !== 'https:') return 'Only https:// URLs are allowed.';
  if (url.username || url.password) return 'URLs with credentials are not allowed.';
  if (url.port && url.port !== '443') return 'Only the standard https port is allowed.';
  if (isIP(url.hostname) || url.hostname === 'localhost' || url.hostname.endsWith('.local'))
    return 'Use a public host name, not an IP address or local name.';
  if (
    kind === 'discord' &&
    !(
      ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'].includes(url.hostname) &&
      url.pathname.startsWith('/api/webhooks/')
    )
  )
    return 'Use a Discord webhook URL (Server settings → Integrations → Webhooks).';
  return null;
}

/** POSTs JSON over https to a public address only; resolves to the status code. */
export function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 8_000
): Promise<number> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: 'POST',
        lookup: publicOnlyLookup,
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'FXSignal-Alerts/1.0',
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out.')));
    req.on('error', reject);
    req.end(payload);
  });
}

// ---- Senders ----------------------------------------------------------------------

export interface ExternalAlert {
  kind: string;
  title: string;
  body: string;
  url: string;
  predictionId: number | null;
}

export async function sendTelegram(chatId: string, alert: ExternalAlert) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Telegram is not configured.');
  const status = await postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: `${alert.title}\n\n${alert.body}\n\n${alert.url}`,
    disable_web_page_preview: true,
  });
  if (status >= 300) throw new Error(`Telegram replied ${status}.`);
}

export async function sendDiscord(webhookUrl: string, alert: ExternalAlert) {
  const status = await postJson(webhookUrl, {
    username: 'FXSignal',
    embeds: [
      {
        title: alert.title.slice(0, 256),
        description: alert.body.slice(0, 2000),
        url: alert.url,
      },
    ],
  });
  if (status >= 300) throw new Error(`Discord replied ${status}.`);
}

/** HMAC-SHA256 of the raw body, hex, as sent in X-FXSignal-Signature. */
export function signBody(secret: string, body: string) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export async function sendWebhook(webhookUrl: string, secret: string, alert: ExternalAlert) {
  const body = {
    kind: alert.kind,
    title: alert.title,
    body: alert.body,
    url: alert.url,
    predictionId: alert.predictionId,
    sentAt: new Date().toISOString(),
  };
  const status = await postJson(webhookUrl, body, {
    'X-FXSignal-Signature': signBody(secret, JSON.stringify(body)),
  });
  if (status >= 300) throw new Error(`Webhook replied ${status}.`);
}

export function newWebhookSecret() {
  return randomBytes(24).toString('base64url');
}

// ---- Telegram linking ----------------------------------------------------------------

const LINK_TTL_MS = 15 * 60_000;

/** A one-time deep link that links the user's Telegram chat when opened. */
export async function telegramLink(userId: number): Promise<string> {
  const username = process.env.TELEGRAM_BOT_USERNAME;
  if (!telegramConfigured() || !username) throw new Error('Telegram is not configured.');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { alertTargets: true } });
  const code = randomBytes(12).toString('base64url');
  await prisma.user.update({
    where: { id: userId },
    data: {
      alertTargets: {
        ...readAlertTargets(user?.alertTargets),
        telegramLinkCode: code,
        telegramLinkExpires: Date.now() + LINK_TTL_MS,
      } as object,
    },
  });
  return `https://t.me/${username}?start=${code}`;
}

let updateOffset = 0;
let polling = false;

/**
 * Reads the bot's new messages once: "/start <code>" links that chat to the
 * user who created the code; "/stop" unlinks it. Called every minute.
 */
export async function pollTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || polling) return;
  polling = true;
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?timeout=0&offset=${updateOffset}`,
      { signal: AbortSignal.timeout(8_000) }
    );
    const data = (await response.json()) as {
      ok: boolean;
      result?: { update_id: number; message?: { chat: { id: number }; text?: string } }[];
    };
    for (const update of data.result ?? []) {
      updateOffset = Math.max(updateOffset, update.update_id + 1);
      const text = update.message?.text?.trim() ?? '';
      const chatId = update.message ? String(update.message.chat.id) : null;
      if (!chatId) continue;
      const start = text.match(/^\/start\s+([A-Za-z0-9_-]{8,64})$/);
      if (start) await linkChat(start[1], chatId, token);
      else if (text === '/stop') await unlinkChat(chatId, token);
    }
  } catch (error) {
    console.warn('Telegram poll failed.', error instanceof Error ? error.message : error);
  } finally {
    polling = false;
  }
}

async function reply(token: string, chatId: string, text: string) {
  await postJson(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text }).catch(
    () => undefined
  );
}

async function linkChat(code: string, chatId: string, token: string) {
  const users = await prisma.user.findMany({
    where: { alertTargets: { path: ['telegramLinkCode'], equals: code } },
    select: { id: true, alertTargets: true },
  });
  const user = users[0];
  const targets = readAlertTargets(user?.alertTargets);
  if (!user || !targets.telegramLinkExpires || targets.telegramLinkExpires < Date.now()) {
    await reply(token, chatId, 'This link has expired. Create a new one in FXSignal → Settings → Alerts.');
    return;
  }
  await prisma.user.update({
    where: { id: user.id },
    data: {
      alertTargets: {
        ...targets,
        telegramChatId: chatId,
        telegramLinkCode: null,
        telegramLinkExpires: null,
      } as object,
    },
  });
  await reply(token, chatId, 'Linked. FXSignal alerts will arrive here. Send /stop to unlink.');
}

async function unlinkChat(chatId: string, token: string) {
  const users = await prisma.user.findMany({
    where: { alertTargets: { path: ['telegramChatId'], equals: chatId } },
    select: { id: true, alertTargets: true },
  });
  for (const user of users)
    await prisma.user.update({
      where: { id: user.id },
      data: { alertTargets: { ...readAlertTargets(user.alertTargets), telegramChatId: null } as object },
    });
  await reply(token, chatId, 'Unlinked. You will not get FXSignal alerts here any more.');
}
