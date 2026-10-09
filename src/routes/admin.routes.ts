import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { adminEmails } from '../lib/admin.js';
import { emailConfigured, pushConfigured } from '../lib/alerts.js';
import { aiAnalysisEnabled, liveDataEnabled } from '../lib/liveData.js';
import { cachedSeriesStatus, creditUsage } from '../lib/rateCache.js';
import {
  fromRow,
  getOpsStatus,
  maintainMarketData,
  onCandleClose,
} from '../lib/predictions.js';
import { PAIRS, pipSize } from '../lib/market.js';
import type { PairCode } from '../lib/model.js';
import { asyncRoute } from '../middleware/asyncRoute.js';
import { backtestRunning, startBacktest } from '../lib/backtest.js';

/** Owner-only operations view. Mounted behind requireAuth + requireAdmin. */
const router = Router();

/** How old a cached series may be before it is flagged (by timeframe). */
const STALE_AFTER_MS: Record<string, number> = {
  M15: 2 * 3_600_000,
  H1: 4 * 3_600_000,
  H4: 12 * 3_600_000,
  DAILY: 4 * 86_400_000,
  WEEKLY: 10 * 86_400_000,
  MONTHLY: 40 * 86_400_000,
};

function candleMs(datetime: string) {
  return Date.parse(
    datetime.includes(' ')
      ? `${datetime.replace(' ', 'T')}Z`
      : `${datetime}T00:00:00Z`
  );
}

router.get(
  '/overview',
  asyncRoute(async (_req, res) => {
    const now = Date.now();
    const dayStart = new Date(new Date().toISOString().slice(0, 10));
    const weekAgo = new Date(now - 7 * 86_400_000);

    const dbStarted = Date.now();
    const dbOk = await prisma.$queryRaw`SELECT 1`.then(
      () => true,
      () => false
    );
    const dbLatencyMs = Date.now() - dbStarted;

    const [
      users,
      pro,
      newThisWeek,
      activeToday,
      pushDevices,
      journalTrades,
      openSignals,
      publishedToday,
      sentToday,
      failedToday,
      failures,
      lastByPair,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { plan: 'PRO' } }),
      prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.user.count({
        where: { lastSeenAt: { gte: new Date(now - 86_400_000) } },
      }),
      prisma.pushSubscription.count(),
      prisma.userTrade.count(),
      prisma.predictionOutcome.count({ where: { status: 'PENDING' } }),
      prisma.prediction.count({
        where: { validFrom: { gte: dayStart }, continuesId: null },
      }),
      prisma.notification.count({ where: { createdAt: { gte: dayStart } } }),
      prisma.alertFailure.count({ where: { createdAt: { gte: dayStart } } }),
      prisma.alertFailure.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      Promise.all(
        PAIRS.map((pair) =>
          prisma.prediction.findFirst({
            where: { pairCode: pair, continuesId: null },
            orderBy: { validFrom: 'desc' },
            include: { outcome: true },
          })
        )
      ),
    ]);

    const series = (await cachedSeriesStatus())
      .map((s) => {
        const tf = s.key.split(':')[1] ?? '';
        const age = s.newest ? now - candleMs(s.newest) : null;
        return {
          ...s,
          ageMinutes: age === null ? null : Math.round(age / 60_000),
          stale: age === null || age > (STALE_AFTER_MS[tf] ?? 86_400_000),
          backingOff: s.failedUntil !== null && s.failedUntil > now,
        };
      })
      .sort((a, b) => a.key.localeCompare(b.key));

    const memory = process.memoryUsage();
    res.json({
      server: {
        startedAt: getOpsStatus().startedAt,
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
        memoryMb: Math.round(memory.rss / 1_048_576),
        dbOk,
        dbLatencyMs,
      },
      jobs: getOpsStatus(),
      config: {
        liveData: liveDataEnabled(),
        modelReview: aiAnalysisEnabled(),
        email: emailConfigured(),
        push: pushConfigured(),
        calendar: Boolean(process.env.TRADING_ECONOMICS_API_KEY),
        admins: adminEmails().size,
      },
      credits: await creditUsage(),
      series,
      counts: {
        users,
        pro,
        newThisWeek,
        activeToday,
        pushDevices,
        journalTrades,
      },
      signals: {
        open: openSignals,
        publishedToday,
        lastByPair: lastByPair
          .filter((row): row is NonNullable<typeof row> => row !== null)
          .map((row) => ({
            pairCode: row.pairCode,
            at: row.validFrom.toISOString(),
            direction: row.direction,
            status: row.outcome?.status ?? 'PENDING',
          })),
      },
      alerts: {
        sentToday,
        failedToday,
        failures: failures.map((f) => ({
          ...f,
          createdAt: f.createdAt.toISOString(),
        })),
      },
    });
  })
);

router.get(
  '/users',
  asyncRoute(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const plan = String(req.query.plan ?? 'ALL').toUpperCase();
    const rows = await prisma.user.findMany({
      where: {
        ...(q
          ? {
              OR: [
                { email: { contains: q, mode: 'insensitive' } },
                { name: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(plan === 'FREE' || plan === 'PRO' ? { plan } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        email: true,
        name: true,
        plan: true,
        planStatus: true,
        createdAt: true,
        lastSeenAt: true,
        _count: {
          select: { trades: true, pushSubscriptions: true, notifications: true },
        },
      },
    });
    res.json({
      users: rows.map(({ _count, ...u }) => ({
        ...u,
        trades: _count.trades,
        pushDevices: _count.pushSubscriptions,
        notifications: _count.notifications,
      })),
    });
  })
);

/** One user's full record: profile, devices, recent trades and notifications. */
router.get(
  '/users/:id',
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id))
      return res.status(400).json({ error: 'Unknown user.' });
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        plan: true,
        planStatus: true,
        createdAt: true,
        lastSeenAt: true,
        pushSubscriptions: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { id: true, createdAt: true },
        },
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const [tradeRows, notifications, counts] = await Promise.all([
      prisma.userTrade.findMany({
        where: { userId: id },
        include: { prediction: { include: { outcome: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      }),
      prisma.notification.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          kind: true,
          title: true,
          createdAt: true,
          readAt: true,
        },
      }),
      prisma.notification.count({ where: { userId: id, readAt: null } }),
    ]);
    res.json({
      user: {
        ...user,
        unreadNotifications: counts,
        pushDevices: user.pushSubscriptions.map((s) => ({
          id: s.id,
          createdAt: s.createdAt.toISOString(),
        })),
      },
      trades: tradeRows.map((row) => {
        const prediction = fromRow(row.prediction);
        const entry =
          row.entryPrice === null ? null : Number(row.entryPrice);
        const exit = row.exitPrice === null ? null : Number(row.exitPrice);
        const pips =
          entry === null || exit === null
            ? null
            : Number(
                (
                  ((row.side === 'SHORT' ? entry - exit : exit - entry) /
                    pipSize(prediction.pairCode as PairCode)) as number
                ).toFixed(1)
              );
        return {
          id: String(row.id),
          pairCode: prediction.pairCode,
          side: row.side,
          entryPrice: entry,
          exitPrice: exit,
          lots:
            row.lots === null || row.lots === undefined
              ? null
              : Number(row.lots),
          exitReason: row.exitReason,
          pips,
          status: row.prediction.outcome?.status ?? 'PENDING',
          updatedAt: row.updatedAt.toISOString(),
        };
      }),
      notifications: notifications.map((n) => ({
        ...n,
        createdAt: n.createdAt.toISOString(),
        read: n.readAt !== null,
      })),
    });
  })
);

/** Permanently delete a user and everything attached to them. */
router.delete(
  '/users/:id',
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id))
      return res.status(400).json({ error: 'Unknown user.' });
    if (id === Number(req.user?.sub))
      return res
        .status(400)
        .json({ error: 'You cannot delete your own admin account.' });
    const existing = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true },
    });
    if (!existing)
      return res.status(404).json({ error: 'User not found.' });
    // Children first so the delete works with or without DB cascades.
    await prisma.$transaction([
      prisma.userTrade.deleteMany({ where: { userId: id } }),
      prisma.notification.deleteMany({ where: { userId: id } }),
      prisma.pushSubscription.deleteMany({ where: { userId: id } }),
      prisma.mt5Link.deleteMany({ where: { userId: id } }),
      prisma.user.delete({ where: { id } }),
    ]);
    console.info(`Admin ${req.user?.sub} deleted user ${existing.email}`);
    res.status(204).end();
  })
);

const planSchema = z.object({ plan: z.enum(['FREE', 'PRO']) });

/** Set a user's plan by hand (useful until payments are live). */
router.patch(
  '/users/:id',
  asyncRoute(async (req, res) => {
    const parsed = planSchema.safeParse(req.body);
    const id = Number(req.params.id);
    if (!parsed.success || !Number.isInteger(id))
      return res.status(400).json({ error: 'Choose FREE or PRO.' });
    const user = await prisma.user.update({
      where: { id },
      data: { plan: parsed.data.plan, planStatus: 'ACTIVE' },
      select: { id: true, plan: true },
    });
    res.json({ user });
  })
);

// ---- Announcements -------------------------------------------------------------

/** Send an in-app announcement to the bell of every user (or one plan). */
const broadcastSchema = z.object({
  title: z.string().trim().min(3).max(80),
  body: z.string().trim().min(3).max(280),
  audience: z.enum(['ALL', 'FREE', 'PRO']).default('ALL'),
});

router.post(
  '/broadcast',
  asyncRoute(async (req, res) => {
    const parsed = broadcastSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: 'Title (3–80) and body (3–280 chars) required.' });
    const { title, body, audience } = parsed.data;
    const targets = await prisma.user.findMany({
      where: audience === 'ALL' ? {} : { plan: audience },
      select: { id: true },
    });
    if (targets.length === 0)
      return res.status(400).json({ error: 'No users in that audience.' });
    const sent = await prisma.notification.createMany({
      data: targets.map((t) => ({
        userId: t.id,
        kind: 'ADMIN_ANNOUNCE',
        title,
        body,
      })),
    });
    console.info(
      `Admin ${req.user?.sub} broadcast "${title}" to ${sent.count} users (${audience})`
    );
    res.json({ sent: sent.count, audience });
  })
);

// ---- Operations ----------------------------------------------------------------

/** Run the market-data maintenance pass now (forced, bypasses cooldowns once). */
router.post(
  '/maintenance',
  asyncRoute(async (_req, res) => {
    await maintainMarketData(new Date(), { force: true });
    res.json({ jobs: getOpsStatus() });
  })
);

/** Run the candle-close loop now (H1 checkpoint + M15 tracking + auto-exits). */
router.post(
  '/candle-loop',
  asyncRoute(async (_req, res) => {
    await onCandleClose(new Date());
    res.json({ jobs: getOpsStatus() });
  })
);

/** Latest published signals with their settlement state. */
router.get(
  '/signals',
  asyncRoute(async (req, res) => {
    const take = Math.min(
      50,
      Math.max(1, Number(req.query.take ?? 20) || 20)
    );
    const rows = await prisma.prediction.findMany({
      orderBy: { validFrom: 'desc' },
      take,
      include: { outcome: true },
    });
    res.json({
      signals: rows.map((row) => {
        const p = fromRow(row);
        return {
          id: p.id,
          pairCode: p.pairCode,
          direction: p.direction,
          session: p.session,
          confidence: p.confidence,
          validFrom: p.validFrom,
          status: row.outcome?.status ?? 'PENDING',
          movementPips:
            row.outcome?.movementPips === null ||
            row.outcome?.movementPips === undefined
              ? null
              : Number(row.outcome.movementPips),
        };
      }),
    });
  })
);

/** Clear the failed-delivery log (kept for diagnosis, safe to empty). */
router.delete(
  '/alert-failures',
  asyncRoute(async (req, res) => {
    const { count } = await prisma.alertFailure.deleteMany({});
    console.info(`Admin ${req.user?.sub} cleared ${count} alert failures`);
    res.json({ cleared: count });
  })
);

// ---- Backtest ------------------------------------------------------------------

router.get(
  '/backtest',
  asyncRoute(async (_req, res) => {
    const runs = await prisma.backtestRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        status: true,
        months: true,
        from: true,
        to: true,
        createdAt: true,
        finishedAt: true,
        summary: true,
        error: true,
      },
    });
    res.json({
      running: backtestRunning(),
      runs: runs.map((r) => {
        const summary = r.summary as {
          trades?: number;
          netR?: number;
          winRate?: number | null;
        } | null;
        return {
          ...r,
          summary: summary
            ? {
                trades: summary.trades,
                netR: summary.netR,
                winRate: summary.winRate,
              }
            : null,
        };
      }),
    });
  })
);

const backtestSchema = z.object({
  months: z.number().int().min(1).max(12).default(6),
});

/** Starts a run in the background (~7 provider credits per pair the first time). */
router.post(
  '/backtest',
  asyncRoute(async (req, res) => {
    const parsed = backtestSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      return res.status(400).json({ error: 'Months must be 1–12.' });
    if (backtestRunning())
      return res.status(409).json({ error: 'A backtest is already running.' });
    const id = await startBacktest(parsed.data.months);
    res.status(202).json({ id });
  })
);

export default router;
