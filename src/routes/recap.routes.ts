import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { fromRow } from '../lib/predictions.js';
import { pipSize, tradingWeekAnchor, weekBounds } from '../lib/market.js';
import { buildRecap, recentWeeks } from '../lib/recap.js';
import { asyncRoute } from '../middleware/asyncRoute.js';
import type { PairCode } from '../lib/model.js';

const router = Router();

const querySchema = z.object({
  /** Monday of the week, YYYY-MM-DD. Defaults to the current (or just-ended) week. */
  week: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

router.get(
  '/',
  asyncRoute(async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success)
      return res.status(400).json({ error: 'Invalid week.' });
    const now = new Date();
    // On Sunday (before the open) the week worth reading is the one that ended.
    const today =
      now.getUTCDay() === 0 ? new Date(now.getTime() - 86_400_000) : now;
    const { weekStart, weekEnd } = weekBounds(
      parsed.data.week
        ? new Date(`${parsed.data.week}T12:00:00Z`)
        : tradingWeekAnchor(today)
    );

    const rows = await prisma.prediction.findMany({
      where: {
        continuesId: null,
        validFrom: { gte: weekStart, lte: weekEnd },
      },
      include: { outcome: true },
      orderBy: { validFrom: 'asc' },
    });
    const signals = rows.map(fromRow);

    const userTrades = await prisma.userTrade.findMany({
      where: {
        userId: Number(req.user?.sub),
        predictionId: { in: rows.map((r) => r.id) },
      },
      include: { prediction: true },
    });
    const pips = userTrades.map((t) => {
      if (t.entryPrice === null || t.exitPrice === null) return { pips: null };
      const entry = Number(t.entryPrice);
      const exit = Number(t.exitPrice);
      const move = t.side === 'SHORT' ? entry - exit : exit - entry;
      return {
        pips: Number(
          (move / pipSize(t.prediction.pairCode as PairCode)).toFixed(1)
        ),
      };
    });

    res.json(buildRecap(weekStart, signals, pips, recentWeeks(today)));
  })
);

export default router;
