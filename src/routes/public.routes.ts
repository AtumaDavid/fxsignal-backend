import { Router } from 'express';
import { z } from 'zod';
import { buildPerformance } from '../lib/performance.js';
import { getHistory } from '../lib/predictions.js';
import { prisma } from '../lib/prisma.js';
import { asyncRoute } from '../middleware/asyncRoute.js';

const router = Router();

const WINDOWS = [30, 90, 365] as const;
const CACHE_MS = 5 * 60_000;
const cache = new Map<number, { at: number; body: unknown }>();

/**
 * Public, unauthenticated track record: aggregates and the most recent settled
 * calls, exactly as scored for signed-in users. Cached for five minutes so a
 * shared link getting traffic cannot load the database.
 */
router.get('/track-record', async (req, res) => {
  const parsed = z
    .object({ days: z.coerce.number().int().default(90) })
    .safeParse(req.query);
  const days =
    parsed.success && (WINDOWS as readonly number[]).includes(parsed.data.days)
      ? parsed.data.days
      : 90;

  const hit = cache.get(days);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json(hit.body);
  }

  try {
    const rows = await getHistory(1000, new Date(), { days, maxRows: 1000 });
    const settled = rows.filter((row) => row.outcome?.status !== 'PENDING');
    const body = {
      days,
      generatedAt: new Date().toISOString(),
      ...buildPerformance(rows),
      recent: settled.slice(0, 25).map((row) => ({
        id: row.id,
        pairCode: row.pairCode,
        direction: row.direction,
        session: row.session,
        confidence: row.confidence,
        validFrom: row.validFrom,
        expiresAt: row.expiresAt,
        entryLow: row.entryLow,
        entryHigh: row.entryHigh,
        targetPrice: row.targetPrice,
        target1Price: row.target1Price,
        target3Price: row.target3Price,
        invalidationPrice: row.invalidationPrice,
        status: row.outcome?.status ?? 'PENDING',
        movementPips: row.outcome?.movementPips ?? null,
      })),
    };
    cache.set(days, { at: Date.now(), body });
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json(body);
  } catch (error) {
    console.warn(
      'Public track record unavailable:',
      error instanceof Error ? error.message : error
    );
    return res
      .status(503)
      .json({ error: 'The track record is unavailable right now.' });
  }
});

/**
 * The newest finished backtest: summary plus every simulated trade, so anyone
 * can check the claim trade by trade.
 */
router.get(
  '/backtest',
  asyncRoute(async (_req, res) => {
    const run = await prisma.backtestRun.findFirst({
      where: { status: 'DONE' },
      orderBy: { finishedAt: 'desc' },
    });
    if (!run)
      return res.status(404).json({ error: 'No backtest published yet.' });
    res.json({
      id: run.id,
      months: run.months,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      summary: run.summary,
      trades: run.trades,
    });
  })
);

export default router;
