import nodemailer, { type Transporter } from 'nodemailer';
import webpush from 'web-push';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import type { Prediction } from './model.js';

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
  MY_TRADE_CLOSED: 'myTrades',
};

export interface AlertPrefs {
  channels: { email: boolean; push: boolean };
  events: Record<AlertGroup, boolean>;
}

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  channels: { email: true, push: true },
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
  channel: 'email' | 'push',
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
  user: { id: number; email: string; alertPrefs: Prisma.JsonValue | null },
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
}

async function fanOut(alert: Delivery, onlyUserId?: number) {
  const users = await prisma.user.findMany({
    where: onlyUserId ? { id: onlyUserId } : {},
    select: { id: true, email: true, alertPrefs: true },
  });
  for (const user of users) {
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
        body: `Price traded into the entry zone ${px(p, p.entryLow)}–${px(p, p.entryHigh)}. Stop ${px(p, p.invalidationPrice)}, ${targets(p)}.`,
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

/** A user's own journal trade was closed automatically at their stop or target. */
export async function announceMyTradeClosed(
  userId: number,
  p: Prediction,
  reason: 'stop' | 'target',
  exitPrice: number,
  resultPips: number | null
) {
  const title =
    `Your ${p.pairCode} ${side(p)} ${reason === 'target' ? 'hit its target' : 'was stopped out'} ${pips(resultPips)}`.trim();
  const body = `Exit recorded in your journal at ${px(p, exitPrice)} (your ${reason}).`;
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
