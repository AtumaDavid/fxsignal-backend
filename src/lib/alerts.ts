import nodemailer, { type Transporter } from 'nodemailer';
import webpush from 'web-push';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import type { Prediction } from './model.js';
import { mt5Drawdown, readRiskPrefs } from './riskPrefs.js';
import {
  readAlertTargets,
  sendDiscord,
  sendTelegram,
  sendWebhook,
  telegramConfigured,
  type ExternalAlert,
} from './externalAlerts.js';

/**
 * Alerts: every signal event is announced once (SignalEvent is the dedupe
 * log), then fanned out per user to the in-app bell (always), email and
 * browser push, according to each user's preferences.
 *
 * Email needs SMTP_* in .env; push needs VAPID_* keys. Without them those
 * channels are simply skipped and the bell still works.
 */

export type AlertKind =
  | 'SIGNAL_NEW'
  | 'ENTRY_FILLED'
  | 'TP1_HIT'
  | 'TP2_HIT'
  | 'TP3_HIT'
  | 'TARGET_HIT'
  | 'STOP_HIT'
  | 'TRAIL_STOP_HIT'
  | 'CANCELLED'
  | 'CLOSED_EARLY'
  | 'APPROACHING_ZONE'
  | 'ZONE_TOUCHED'
  | 'CONFIRMATION_EXPIRED'
  | 'ENTRY_BLOCKED_NEWS'
  | 'SETUP_VOID'
  | 'TRADING_PAUSED'
  | 'MY_TRADE_CLOSED';

/** Groups the user can switch on/off. */
export type AlertGroup =
  'newSignal' | 'entry' | 'result' | 'checkpoint' | 'myTrades';

const GROUP_OF: Record<AlertKind, AlertGroup> = {
  SIGNAL_NEW: 'newSignal',
  ENTRY_FILLED: 'entry',
  // Trade management steps ride with the entry alerts: same "act now" moment.
  TP1_HIT: 'entry',
  TP2_HIT: 'entry',
  TP3_HIT: 'result',
  TARGET_HIT: 'result',
  STOP_HIT: 'result',
  TRAIL_STOP_HIT: 'result',
  CANCELLED: 'checkpoint',
  CLOSED_EARLY: 'checkpoint',
  // Before entry: "get ready" moments ride with the entry alerts.
  APPROACHING_ZONE: 'entry',
  ZONE_TOUCHED: 'entry',
  CONFIRMATION_EXPIRED: 'checkpoint',
  ENTRY_BLOCKED_NEWS: 'checkpoint',
  SETUP_VOID: 'checkpoint',
  TRADING_PAUSED: 'checkpoint',
  MY_TRADE_CLOSED: 'myTrades',
};

export interface AlertPrefs {
  /** External channels send only once their destination is set up. */
  channels: {
    email: boolean;
    push: boolean;
    telegram: boolean;
    discord: boolean;
    webhook: boolean;
  };
  events: Record<AlertGroup, boolean>;
}

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  channels: { email: true, push: true, telegram: true, discord: true, webhook: true },
  events: {
    newSignal: true,
    entry: true,
    result: true,
    checkpoint: true,
    myTrades: true,
  },
};

export function readAlertPrefs(value: unknown): AlertPrefs {
  const raw = (value ?? {}) as Partial<AlertPrefs>;
  return {
    channels: { ...DEFAULT_ALERT_PREFS.channels, ...(raw.channels ?? {}) },
    events: { ...DEFAULT_ALERT_PREFS.events, ...(raw.events ?? {}) },
  };
}

// ---- Channels ----------------------------------------------------------------

let transporter: Transporter | null | undefined;

/** SMTP transport (Gmail app password, Brevo, Resend SMTP, ...), or null if not configured. */
function mailer(): Transporter | null {
  if (transporter !== undefined) return transporter;
  const host = process.env.SMTP_HOST;
  if (!host || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    transporter = null;
    return transporter;
  }
  const port = Number(process.env.SMTP_PORT ?? 465);
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

export function emailConfigured() {
  return mailer() !== null;
}

let vapidReady: boolean | undefined;

export function vapidPublicKey(): string | null {
  return pushConfigured() ? (process.env.VAPID_PUBLIC_KEY ?? null) : null;
}

export function pushConfigured() {
  if (vapidReady !== undefined) return vapidReady;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    vapidReady = false;
    return vapidReady;
  }
  try {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT ?? 'mailto:alerts@fxsignal.app',
      pub,
      priv
    );
    vapidReady = true;
  } catch (error) {
    console.warn(
      'VAPID keys are invalid; browser push disabled.',
      error instanceof Error ? error.message : error
    );
    vapidReady = false;
  }
  return vapidReady;
}

const APP_URL = (
  process.env.APP_URL ?? 'https://fxsignal-frontend.vercel.app'
).replace(/\/+$/, '');

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function emailHtml(title: string, body: string, path: string) {
  return `<!doctype html><html><body style="margin:0;background:#0a0a0c;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#ededef">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
<table width="100%" style="max-width:520px;background:#111114;border:1px solid #26262c;border-radius:12px" cellpadding="0" cellspacing="0">
<tr><td style="padding:22px 24px 6px;font-size:13px;color:#8b8b94">FXSignal</td></tr>
<tr><td style="padding:0 24px;font-size:18px;font-weight:600;line-height:1.4">${escapeHtml(title)}</td></tr>
<tr><td style="padding:10px 24px 20px;font-size:14px;line-height:1.6;color:#b4b4bc">${escapeHtml(body)}</td></tr>
<tr><td style="padding:0 24px 24px"><a href="${APP_URL}${path}" style="display:inline-block;background:#ededef;color:#0a0a0c;text-decoration:none;font-size:13px;font-weight:600;padding:10px 16px;border-radius:8px">Open FXSignal</a></td></tr>
</table>
<p style="font-size:11px;color:#5c5c66;margin-top:16px">Market analysis for research and education, not financial advice. Change alerts in Settings.</p>
</td></tr></table></body></html>`;
}

interface Delivery {
  kind: AlertKind;
  title: string;
  body: string;
  predictionId: number | null;
  /** App path the alert opens. */
  path: string;
  /** Test message: ignore the per-event switches (channels still apply). */
  test?: boolean;
}

/** Kept for the admin page; never throws. */
async function recordFailure(
  userId: number,
  channel: 'email' | 'push' | 'telegram' | 'discord' | 'webhook',
  kind: string,
  error: unknown
) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error);
  await prisma.alertFailure
    .create({
      data: { userId, channel, kind, error: message.slice(0, 500) },
    })
    .catch(() => undefined);
}

async function deliverTo(
  user: {
    id: number;
    email: string;
    alertPrefs: Prisma.JsonValue | null;
    alertTargets?: Prisma.JsonValue | null;
  },
  alert: Delivery
) {
  const prefs = readAlertPrefs(user.alertPrefs);
  if (!alert.test && !prefs.events[GROUP_OF[alert.kind]]) return;

  await prisma.notification.create({
    data: {
      userId: user.id,
      kind: alert.kind,
      title: alert.title,
      body: alert.body,
      predictionId: alert.predictionId,
    },
  });

  const mail = prefs.channels.email ? mailer() : null;
  if (mail) {
    await mail
      .sendMail({
        from: process.env.EMAIL_FROM ?? process.env.SMTP_USER,
        to: user.email,
        subject: alert.title,
        text: `${alert.body}\n\n${APP_URL}${alert.path}`,
        html: emailHtml(alert.title, alert.body, alert.path),
      })
      .catch((error: unknown) => {
        console.warn(
          `Alert email to user ${user.id} failed.`,
          error instanceof Error ? error.message : error
        );
        void recordFailure(user.id, 'email', alert.kind, error);
      });
  }

  if (prefs.channels.push && pushConfigured()) {
    const subs = await prisma.pushSubscription.findMany({
      where: { userId: user.id },
    });
    const payload = JSON.stringify({
      title: alert.title,
      body: alert.body,
      url: alert.path,
    });
    for (const sub of subs) {
      await webpush
        .sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
          // Time-sensitive: without "high", phones in power-saving mode
          // may hold the alert back until they wake up.
          { TTL: 60 * 60, urgency: 'high' }
        )
        .catch(async (error: { statusCode?: number; message?: string }) => {
          // Gone / not found: the browser dropped the subscription.
          if (error.statusCode === 404 || error.statusCode === 410) {
            await prisma.pushSubscription
              .delete({ where: { id: sub.id } })
              .catch(() => undefined);
          } else {
            console.warn(
              `Push to user ${user.id} failed.`,
              error.message ?? error
            );
            void recordFailure(user.id, 'push', alert.kind, error);
          }
        });
    }
  }

  // Telegram, Discord, webhook: only where the user set a destination.
  const targets = readAlertTargets(user.alertTargets);
  const external: ExternalAlert = {
    kind: alert.kind,
    title: alert.title,
    body: alert.body,
    url: `${APP_URL}${alert.path}`,
    predictionId: alert.predictionId,
  };
  const sends: [AlertChannel, (() => Promise<void>) | null][] = [
    [
      'telegram',
      prefs.channels.telegram && targets.telegramChatId && telegramConfigured()
        ? () => sendTelegram(targets.telegramChatId!, external)
        : null,
    ],
    [
      'discord',
      prefs.channels.discord && targets.discordWebhookUrl
        ? () => sendDiscord(targets.discordWebhookUrl!, external)
        : null,
    ],
    [
      'webhook',
      prefs.channels.webhook && targets.webhookUrl && targets.webhookSecret
        ? () => sendWebhook(targets.webhookUrl!, targets.webhookSecret!, external)
        : null,
    ],
  ];
  for (const [channel, send] of sends) {
    if (!send) continue;
    await send().catch((error: unknown) => {
      console.warn(
        `${channel} alert to user ${user.id} failed.`,
        error instanceof Error ? error.message : error
      );
      void recordFailure(user.id, channel, alert.kind, error);
    });
  }
}

type AlertChannel = 'telegram' | 'discord' | 'webhook';

async function fanOut(alert: Delivery, onlyUserId?: number) {
  const users = await prisma.user.findMany({
    where: onlyUserId ? { id: onlyUserId } : {},
    select: { id: true, email: true, alertPrefs: true, alertTargets: true, riskPrefs: true },
  });
  const links =
    alert.kind === 'SIGNAL_NEW'
      ? new Map(
          (
            await prisma.mt5Link.findMany({
              where: { userId: { in: users.map((u) => u.id) } },
            })
          ).map((l) => [l.userId, l])
        )
      : new Map();
  for (const user of users) {
    // Past the user's drawdown limit (MT5 equity): no new-signal prompts.
    if (
      alert.kind === 'SIGNAL_NEW' &&
      mt5Drawdown(readRiskPrefs(user.riskPrefs), links.get(user.id) ?? null)?.paused
    )
      continue;
    await deliverTo(user, alert).catch((error) =>
      console.warn(
        `Alert delivery to user ${user.id} failed.`,
        error instanceof Error ? error.message : error
      )
    );
  }
}

// ---- Events ------------------------------------------------------------------

function side(p: Prediction) {
  return p.direction === 'LONG' ? 'long' : 'short';
}

function px(p: Prediction, value: number | null | undefined) {
  if (value === null || value === undefined) return '—';
  return value.toFixed(p.pairCode === 'EUR/USD' ? 5 : 3);
}

function pips(value: number | null | undefined) {
  if (value === null || value === undefined) return '';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} pips`;
}

/** Notes start with the same phrase as the title; drop it from the body. */
function noteBody(note: string | null | undefined) {
  return (
    note?.replace(/^(Cancelled before entry|Exit suggested): /, '') ?? null
  );
}

function targets(p: Prediction) {
  return p.target3Price
    ? `TP1 ${px(p, p.target1Price)}, TP2 ${px(p, p.targetPrice)}, TP3 ${px(p, p.target3Price)}`
    : `target ${px(p, p.targetPrice)} (${p.riskReward ?? '—'}R)`;
}

export function composeAlert(
  kind: AlertKind,
  p: Prediction,
  extra: { price?: number | null; pips?: number | null; note?: string | null }
) {
  const name = `${p.pairCode} ${side(p)}`;
  switch (kind) {
    case 'SIGNAL_NEW':
      return {
        title: `New ${p.session} signal: ${name}`,
        body: `Entry ${px(p, p.entryLow)}–${px(p, p.entryHigh)}, stop ${px(p, p.invalidationPrice)}, ${targets(p)}. Wait for an M15 close in the trade direction before entering.`,
      };
    case 'ENTRY_FILLED':
      return {
        title: `Entry triggered: ${name}`,
        body:
          p.entryTrigger === 'M15_CLOSE'
            ? `An M15 candle confirmed inside the entry zone ${px(p, p.entryLow)}–${px(p, p.entryHigh)}${extra.price ? `; filled at ${px(p, extra.price)}` : ''}. Stop ${px(p, p.invalidationPrice)}, ${targets(p)}.`
            : `Price traded into the entry zone ${px(p, p.entryLow)}–${px(p, p.entryHigh)}. Stop ${px(p, p.invalidationPrice)}, ${targets(p)}.`,
      };
    case 'TP1_HIT':
      return {
        title: `TP1 hit: ${name} — move stop to entry`,
        body: `${p.pairCode} reached TP1 ${px(p, p.target1Price)}. Close a third and move the stop to your entry (${px(p, (p.entryLow + p.entryHigh) / 2)}): the trade can no longer lose. Next: TP2 ${px(p, p.targetPrice)}.`,
      };
    case 'TP2_HIT':
      return {
        title: `TP2 hit: ${name} — move stop to TP1`,
        body: `${p.pairCode} reached TP2 ${px(p, p.targetPrice)}. Close another third and move the stop to TP1 (${px(p, p.target1Price)}) to lock in profit. Last target: TP3 ${px(p, p.target3Price)}.`,
      };
    case 'TP3_HIT':
      return {
        title: `TP3 hit: ${name} ${pips(extra.pips)} — trade complete`.trim(),
        body: `${p.pairCode} reached the final target ${px(p, p.target3Price)}. Close the last third.`,
      };
    case 'TARGET_HIT':
      return {
        title: `Target hit: ${name} ${pips(extra.pips)}`.trim(),
        body: `${p.pairCode} reached the target ${px(p, p.targetPrice)}.`,
      };
    case 'TRAIL_STOP_HIT':
      return {
        title: `Closed in profit: ${name} ${pips(extra.pips)}`.trim(),
        body: `${p.pairCode}: ${extra.note ?? 'The rest closed at the trailed stop.'}`,
      };
    case 'STOP_HIT':
      return {
        title: `Stopped out: ${name} ${pips(extra.pips)}`.trim(),
        body: `${p.pairCode} traded through the invalidation level ${px(p, p.invalidationPrice)}.`,
      };
    case 'CANCELLED':
      return {
        title: `Cancelled before entry: ${name}`,
        body:
          noteBody(extra.note) ??
          'The setup broke on an H1 close before the entry zone filled.',
      };
    case 'APPROACHING_ZONE':
      return {
        title: `Approaching the zone: ${name}`,
        body: `${p.pairCode} is at ${px(p, extra.price)}, within a few pips of the entry zone ${px(p, p.entryLow)}–${px(p, p.entryHigh)}. Entry needs an M15 close in the trade direction inside the zone.`,
      };
    case 'ZONE_TOUCHED':
      return {
        title: `In the zone: ${name} — waiting for M15 confirmation`,
        body: `Price traded into ${px(p, p.entryLow)}–${px(p, p.entryHigh)}. Enter only after an M15 candle closes ${p.direction === 'LONG' ? 'bullish' : 'bearish'} inside the zone; stop ${px(p, p.invalidationPrice)}.`,
      };
    case 'CONFIRMATION_EXPIRED':
      return {
        title: `Confirmation expired: ${name}`,
        body: `Price left the entry zone without an M15 confirmation. The setup stays valid only if price returns to ${px(p, p.entryLow)}–${px(p, p.entryHigh)}.`,
      };
    case 'ENTRY_BLOCKED_NEWS':
      return {
        title: `Entry blocked by news: ${name}`,
        body: `A confirmation formed inside a high-impact news window, so no entry was taken. Entries resume after the window if price is still in the zone.`,
      };
    case 'SETUP_VOID':
      return {
        title: `Setup void: ${name}`,
        body:
          extra.note === 'MOVED_AWAY'
            ? `Price reached TP1 ${px(p, p.target1Price)} before any confirmation. The move is not chased — no entry.`
            : `The invalidation level ${px(p, p.invalidationPrice)} traded before any confirmation. No entry.`,
      };
    case 'TRADING_PAUSED':
      return {
        title: 'Trading paused for today',
        body: `${extra.note ?? 'The daily loss limit was reached.'} New signals resume tomorrow (UTC).`,
      };
    case 'CLOSED_EARLY':
      return {
        title: `Exit suggested: ${name} ${pips(extra.pips)}`.trim(),
        body: `${noteBody(extra.note) ?? 'Strong H1 evidence against the trade.'} Exit price ${px(p, extra.price)}.`,
      };
    default:
      return { title: name, body: extra.note ?? '' };
  }
}

/**
 * Announces a signal event once. Safe to call repeatedly: the SignalEvent
 * unique (predictionId, kind) makes every call after the first a no-op.
 */
export async function announceSignalEvent(
  kind: Exclude<AlertKind, 'MY_TRADE_CLOSED'>,
  p: Prediction,
  extra: {
    price?: number | null;
    pips?: number | null;
    note?: string | null;
  } = {},
  /** Record the event without alerting anyone (it is too old to be useful). */
  options: { silent?: boolean } = {}
) {
  const predictionId = Number(p.id);
  if (!Number.isFinite(predictionId)) return;
  try {
    await prisma.signalEvent.create({ data: { predictionId, kind } });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    )
      return;
    throw error;
  }
  if (options.silent) return;
  const { title, body } = composeAlert(kind, p, extra);
  console.info(`Alert ${kind} #${predictionId}: ${title}`);
  await fanOut({ kind, title, body, predictionId, path: '/app/signals' });
}

/** A user's own journal trade was closed automatically: target, stop or breakeven scratch. */
export async function announceMyTradeClosed(
  userId: number,
  p: Prediction,
  reason: 'stop' | 'target' | 'breakeven',
  exitPrice: number,
  resultPips: number | null
) {
  const outcome =
    reason === 'target'
      ? 'hit its target'
      : reason === 'breakeven'
        ? 'closed at breakeven'
        : 'was stopped out';
  const title =
    `Your ${p.pairCode} ${side(p)} ${outcome} ${pips(resultPips)}`.trim();
  const body = `Exit recorded in your journal at ${px(p, exitPrice)} (${reason === 'breakeven' ? 'breakeven scratch, no gain no loss' : `your ${reason}`}).`;
  await fanOut(
    {
      kind: 'MY_TRADE_CLOSED',
      title,
      body,
      predictionId: Number(p.id),
      path: '/app/journal',
    },
    userId
  );
}

/** Test message on every enabled channel for one user. */
export async function sendTestAlert(userId: number) {
  await fanOut(
    {
      kind: 'MY_TRADE_CLOSED',
      title: 'FXSignal test alert',
      body: 'Alerts are working. You will be notified about signals and your journal trades here.',
      predictionId: null,
      path: '/app/settings',
      test: true,
    },
    userId
  );
}
