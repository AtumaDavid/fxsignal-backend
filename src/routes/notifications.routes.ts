import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  emailConfigured,
  pushConfigured,
  readAlertPrefs,
  sendTestAlert,
  vapidPublicKey,
} from '../lib/alerts.js';
import {
  newWebhookSecret,
  readAlertTargets,
  telegramConfigured,
  telegramLink,
  urlProblem,
  type AlertTargets,
} from '../lib/externalAlerts.js';
import { asyncRoute } from '../middleware/asyncRoute.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

/**
 * Retention policy: notifications are kept for 30 days and capped at 200 per
 * user. Anything older (or beyond the cap) is deleted automatically, so the
 * bell stays fast without any manual cleanup. Users can also delete single
 * notifications or clear read/all from the Notifications page.
 */
export const NOTIFICATION_RETENTION_DAYS = 30;
export const NOTIFICATION_MAX_PER_USER = 200;

/** Best-effort prune for one user; never blocks the request on failure. */
export async function pruneNotifications(userId: number) {
  try {
    const cutoff = new Date(
      Date.now() - NOTIFICATION_RETENTION_DAYS * 86_400_000
    );
    await prisma.notification.deleteMany({
      where: { userId, createdAt: { lt: cutoff } },
    });
    // Enforce the per-user cap: drop the oldest rows beyond the newest N.
    const ids = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
      take: NOTIFICATION_MAX_PER_USER + 1,
    });
    if (ids.length > NOTIFICATION_MAX_PER_USER) {
      const overflow = ids.slice(NOTIFICATION_MAX_PER_USER).map((r) => r.id);
      await prisma.notification.deleteMany({
        where: { userId, id: { in: overflow } },
      });
    }
  } catch {
    // Pruning is housekeeping; the list request still succeeds.
  }
}

/** Global prune for the maintenance loop (all users). */
export async function pruneAllNotifications() {
  try {
    const cutoff = new Date(
      Date.now() - NOTIFICATION_RETENTION_DAYS * 86_400_000
    );
    await prisma.notification.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
  } catch (error) {
    console.warn(
      'Notification prune failed.',
      error instanceof Error ? error.message : error
    );
  }
}

/** Latest notifications for the bell, plus the unread count. */
router.get(
  '/',
  asyncRoute(async (req, res) => {
    const userId = Number(req.user?.sub);
    await pruneNotifications(userId);
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    res.json({
      unread,
      items: items.map((n) => ({
        id: String(n.id),
        kind: n.kind,
        title: n.title,
        body: n.body,
        predictionId: n.predictionId === null ? null : String(n.predictionId),
        createdAt: n.createdAt.toISOString(),
        read: n.readAt !== null,
      })),
    });
  })
);

/** Mark everything (or the given ids) as read. */
router.post(
  '/read',
  asyncRoute(async (req, res) => {
    const userId = Number(req.user?.sub);
    const parsed = z
      .object({ ids: z.array(z.coerce.number().int()).max(100).optional() })
      .safeParse(req.body ?? {});
    const ids = parsed.success ? parsed.data.ids : undefined;
    await prisma.notification.updateMany({
      where: { userId, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
      data: { readAt: new Date() },
    });
    res.status(204).end();
  })
);

/** Delete one notification. */
router.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const userId = Number(req.user?.sub);
    const id = Number(req.params.id);
    if (!Number.isInteger(id))
      return res.status(400).json({ error: 'Unknown notification.' });
    await prisma.notification.deleteMany({ where: { id, userId } });
    res.status(204).end();
  })
);

/**
 * Bulk delete: `mode=read` removes read notifications only (safe default),
 * `mode=all` clears everything for this user.
 */
router.delete(
  '/',
  asyncRoute(async (req, res) => {
    const userId = Number(req.user?.sub);
    const parsed = z
      .object({ mode: z.enum(['read', 'all']).default('read') })
      .safeParse(req.body ?? {});
    if (!parsed.success)
      return res.status(400).json({ error: 'Choose read or all.' });
    await prisma.notification.deleteMany({
      where:
        parsed.data.mode === 'all'
          ? { userId }
          : { userId, readAt: { not: null } },
    });
    res.status(204).end();
  })
);

/** What the server can send, and this user's switches. */
router.get(
  '/settings',
  asyncRoute(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: Number(req.user?.sub) },
      select: { alertPrefs: true, email: true, alertTargets: true },
    });
    if (!user)
      return res.status(401).json({ error: 'Account no longer exists.' });
    const targets = readAlertTargets(user.alertTargets);
    res.json({
      prefs: readAlertPrefs(user.alertPrefs),
      telegramAvailable: telegramConfigured(),
      destinations: {
        telegramLinked: Boolean(targets.telegramChatId),
        discordWebhookUrl: targets.discordWebhookUrl
          ? maskUrl(targets.discordWebhookUrl)
          : null,
        webhookUrl: targets.webhookUrl ?? null,
        webhookSecret: targets.webhookSecret ?? null,
      },
      email: user.email,
      emailAvailable: emailConfigured(),
      pushAvailable: pushConfigured(),
      vapidPublicKey: vapidPublicKey(),
      pushDevices: await prisma.pushSubscription.count({
        where: { userId: Number(req.user?.sub) },
      }),
    });
  })
);

const prefsSchema = z.object({
  channels: z.object({
    email: z.boolean(),
    push: z.boolean(),
    telegram: z.boolean().default(true),
    discord: z.boolean().default(true),
    webhook: z.boolean().default(true),
  }),
  events: z.object({
    newSignal: z.boolean(),
    entry: z.boolean(),
    result: z.boolean(),
    checkpoint: z.boolean(),
    myTrades: z.boolean(),
  }),
});

router.put(
  '/settings',
  asyncRoute(async (req, res) => {
    const parsed = prefsSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: 'Invalid alert settings.' });
    await prisma.user.update({
      where: { id: Number(req.user?.sub) },
      data: { alertPrefs: parsed.data },
    });
    res.json({ prefs: parsed.data });
  })
);

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

router.post(
  '/push/subscribe',
  asyncRoute(async (req, res) => {
    const parsed = subscriptionSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: 'Invalid push subscription.' });
    const userId = Number(req.user?.sub);
    const { endpoint, keys } = parsed.data;
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { userId, endpoint, p256dh: keys.p256dh, auth: keys.auth },
      update: { userId, p256dh: keys.p256dh, auth: keys.auth },
    });
    res.status(204).end();
  })
);

router.post(
  '/push/unsubscribe',
  asyncRoute(async (req, res) => {
    const endpoint = z.string().url().safeParse(req.body?.endpoint);
    if (endpoint.success) {
      await prisma.pushSubscription.deleteMany({
        where: { userId: Number(req.user?.sub), endpoint: endpoint.data },
      });
    }
    res.status(204).end();
  })
);

/** Discord webhook URLs are secrets: show the start and the last 4 characters. */
function maskUrl(url: string) {
  return `${url.slice(0, url.indexOf('/api/webhooks/') + 14)}…${url.slice(-4)}`;
}

/** A one-time Telegram deep link that links this user's chat. */
router.post(
  '/telegram/link',
  rateLimit(5, 10 * 60_000),
  asyncRoute(async (req, res) => {
    if (!telegramConfigured())
      return res.status(503).json({ error: 'Telegram alerts are not set up on this server.' });
    res.json({ url: await telegramLink(Number(req.user?.sub)) });
  })
);

router.delete(
  '/telegram',
  asyncRoute(async (req, res) => {
    await updateTargets(Number(req.user?.sub), { telegramChatId: null });
    res.status(204).end();
  })
);

const destinationsSchema = z.object({
  /** null clears; omitted keeps. */
  discordWebhookUrl: z.string().trim().max(500).nullable().optional(),
  webhookUrl: z.string().trim().max(500).nullable().optional(),
  /** true issues a new signing secret. */
  rotateSecret: z.boolean().optional(),
});

router.put(
  '/destinations',
  asyncRoute(async (req, res) => {
    const parsed = destinationsSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: 'Invalid destinations.' });
    const { discordWebhookUrl, webhookUrl, rotateSecret } = parsed.data;
    for (const [value, kind] of [
      [discordWebhookUrl, 'discord'],
      [webhookUrl, 'webhook'],
    ] as const) {
      const problem = value ? urlProblem(value, kind) : null;
      if (problem) return res.status(400).json({ error: problem });
    }
    const userId = Number(req.user?.sub);
    const current = readAlertTargets(
      (await prisma.user.findUnique({ where: { id: userId }, select: { alertTargets: true } }))
        ?.alertTargets
    );
    const patch: AlertTargets = {};
    if (discordWebhookUrl !== undefined) patch.discordWebhookUrl = discordWebhookUrl || null;
    if (webhookUrl !== undefined) {
      patch.webhookUrl = webhookUrl || null;
      if (webhookUrl && !current.webhookSecret) patch.webhookSecret = newWebhookSecret();
    }
    if (rotateSecret) patch.webhookSecret = newWebhookSecret();
    const next = await updateTargets(userId, patch);
    res.json({
      telegramLinked: Boolean(next.telegramChatId),
      discordWebhookUrl: next.discordWebhookUrl ? maskUrl(next.discordWebhookUrl) : null,
      webhookUrl: next.webhookUrl ?? null,
      webhookSecret: next.webhookSecret ?? null,
    });
  })
);

async function updateTargets(userId: number, patch: AlertTargets) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { alertTargets: true },
  });
  const next = { ...readAlertTargets(user?.alertTargets), ...patch };
  await prisma.user.update({
    where: { id: userId },
    data: { alertTargets: next as object },
  });
  return next;
}

/** One test alert on every enabled channel (3 per 10 minutes). */
router.post(
  '/test',
  rateLimit(3, 10 * 60_000),
  asyncRoute(async (req, res) => {
    await sendTestAlert(Number(req.user?.sub));
    res.status(204).end();
  })
);

export default router;
