import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { adminEmails } from '../lib/admin.js';
import { emailConfigured, pushConfigured } from '../lib/alerts.js';
import { aiAnalysisEnabled, liveDataEnabled } from '../lib/liveData.js';
import { cachedSeriesStatus, creditUsage } from '../lib/rateCache.js';
import { getOpsStatus } from '../lib/predictions.js';
import { PAIRS } from '../lib/market.js';
import { asyncRoute } from '../middleware/asyncRoute.js';

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
    const rows = await prisma.user.findMany({
      where: q
        ? {
            OR: [
              { email: { contains: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {},
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
        _count: { select: { trades: true, pushSubscriptions: true } },
      },
    });
    res.json({
      users: rows.map(({ _count, ...u }) => ({
        ...u,
        trades: _count.trades,
        pushDevices: _count.pushSubscriptions,
      })),
    });
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

export default router;
