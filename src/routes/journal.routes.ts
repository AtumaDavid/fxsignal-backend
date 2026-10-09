import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { fromRow } from '../lib/predictions.js';
import { pipSize } from '../lib/market.js';
import { asyncRoute } from '../middleware/asyncRoute.js';
import type { PairCode, Prediction } from '../lib/model.js';

const router = Router();

const priceField = z.coerce.number().positive().finite().nullable().optional();

const tradeSchema = z.object({
  side: z.enum(['LONG', 'SHORT']).optional(),
  entryPrice: priceField,
  exitPrice: priceField,
  lots: z.coerce.number().positive().max(10_000).nullable().optional(),
  stopPrice: priceField,
  targetPrice: priceField,
  notes: z.string().trim().max(2000).nullable().optional(),
});

type TradeRow = {
  id: number;
  side: string;
  entryPrice: unknown;
  exitPrice: unknown;
  lots: unknown;
  stopPrice: unknown;
  targetPrice: unknown;
  exitedAt: Date | null;
  exitReason: string | null;
  notes: string | null;
  source?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function num(value: unknown) {
  return value === null || value === undefined ? null : Number(value);
}

/** The user's result in pips, signed by their side; null until both prices are known. */
function tradePips(
  pair: PairCode,
  side: string,
  entry: number | null,
  exit: number | null
) {
  if (entry === null || exit === null) return null;
  const move = side === 'SHORT' ? entry - exit : exit - entry;
  return Number((move / pipSize(pair)).toFixed(1));
}

function toTrade(row: TradeRow, prediction: Prediction) {
  const entryPrice = num(row.entryPrice);
  const exitPrice = num(row.exitPrice);
  return {
    id: String(row.id),
    predictionId: prediction.id,
    side: row.side as 'LONG' | 'SHORT',
    entryPrice,
    exitPrice,
    lots: num(row.lots),
    stopPrice: num(row.stopPrice),
    targetPrice: num(row.targetPrice),
    exitedAt: row.exitedAt?.toISOString() ?? null,
    exitReason: row.exitReason,
    notes: row.notes,
    source: row.source ?? null,
    pips: tradePips(prediction.pairCode, row.side, entryPrice, exitPrice),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    prediction,
  };
}

/** Rejects obvious typos (a missing decimal point) by bounding prices near the signal. */
function plausible(prediction: Prediction, value: number | null | undefined) {
  if (value === null || value === undefined) return true;
  const mid = (prediction.entryLow + prediction.entryHigh) / 2;
  return Math.abs(value - mid) / mid < 0.1;
}

type Trade = ReturnType<typeof toTrade>;

/**
 * The user's closed trades grouped (by pair, by session), best net pips
 * first, so the journal can show where they trade best.
 */
function breakdown(closed: Trade[], keyOf: (t: Trade) => string) {
  const groups = new Map<string, Trade[]>();
  for (const trade of closed) {
    const key = keyOf(trade);
    groups.set(key, [...(groups.get(key) ?? []), trade]);
  }
  return [...groups.entries()]
    .map(([key, trades]) => {
      const pips = trades.map((t) => t.pips ?? 0);
      const wins = pips.filter((p) => p > 0).length;
      const losses = pips.filter((p) => p < 0).length;
      const net = pips.reduce((a, b) => a + b, 0);
      return {
        key,
        trades: trades.length,
        wins,
        losses,
        winRate:
          wins + losses > 0
            ? Number(((wins / (wins + losses)) * 100).toFixed(1))
            : null,
        netPips: Number(net.toFixed(1)),
        avgPips: Number((net / trades.length).toFixed(1)),
      };
    })
    .sort((a, b) => b.netPips - a.netPips);
}

router.get(
  '/',
  asyncRoute(async (req, res) => {
    const rows = await prisma.userTrade.findMany({
      where: { userId: Number(req.user?.sub) },
      include: { prediction: { include: { outcome: true } } },
      orderBy: { prediction: { validFrom: 'desc' } },
      take: 500,
    });
    const trades = rows.map((row) => toTrade(row, fromRow(row.prediction)));

    // Side by side: the user's pips vs the engine's on the same signals.
    const closed = trades.filter((t) => t.pips !== null);
    const sum = (values: number[]) =>
      Number(values.reduce((a, b) => a + b, 0).toFixed(1));
    const engineScored = trades.filter((t) =>
      ['HIT', 'MISSED', 'CLOSED_EARLY', 'BREAKEVEN'].includes(
        t.prediction.outcome?.status ?? ''
      )
    );
    res.json({
      trades,
      summary: {
        logged: trades.length,
        closed: closed.length,
        open: trades.length - closed.length,
        wins: closed.filter((t) => (t.pips ?? 0) > 0).length,
        losses: closed.filter((t) => (t.pips ?? 0) < 0).length,
        netPips: sum(closed.map((t) => t.pips ?? 0)),
        engineNetPips: sum(
          engineScored.map((t) => t.prediction.outcome?.movementPips ?? 0)
        ),
        engineScored: engineScored.length,
      },
      byPair: breakdown(closed, (t) => t.prediction.pairCode),
      bySession: breakdown(closed, (t) => t.prediction.session),
    });
  })
);

router.put(
  '/:predictionId',
  asyncRoute(async (req, res) => {
    const predictionId = Number(req.params.predictionId);
    const parsed = tradeSchema.safeParse(req.body);
    if (!Number.isInteger(predictionId) || !parsed.success) {
      return res.status(400).json({
        error: parsed.success
          ? 'Unknown signal.'
          : (parsed.error.issues[0]?.message ?? 'Invalid trade details.'),
      });
    }
    const row = await prisma.prediction.findUnique({
      where: { id: predictionId },
      include: { outcome: true },
    });
    if (!row)
      return res.status(404).json({ error: 'That signal no longer exists.' });
    const prediction = fromRow(row);

    const data = parsed.data;
    const side =
      data.side ??
      (prediction.direction === 'NEUTRAL' ? null : prediction.direction);
    if (!side) {
      return res.status(400).json({
        error:
          'This was a neutral call — choose whether you went long or short.',
      });
    }
    if (
      [data.entryPrice, data.exitPrice, data.stopPrice, data.targetPrice].some(
        (value) => !plausible(prediction, value)
      )
    ) {
      return res.status(400).json({
        error: `Prices should be close to ${prediction.pairCode}'s level at the time — check the decimal point.`,
      });
    }

    const userId = Number(req.user?.sub);
    const existing = await prisma.userTrade.findUnique({
      where: { userId_predictionId: { userId, predictionId } },
    });
    const exitPrice = data.exitPrice ?? null;
    const sameExit =
      existing?.exitPrice !== null &&
      existing?.exitPrice !== undefined &&
      exitPrice !== null &&
      Number(existing.exitPrice) === exitPrice;
    const fields = {
      side,
      entryPrice: data.entryPrice ?? null,
      exitPrice,
      lots: data.lots ?? null,
      stopPrice: data.stopPrice ?? null,
      targetPrice: data.targetPrice ?? null,
      // Keep an automatically detected exit's reason/time when it is
      // unchanged; a typed exit is "manual"; no exit clears both.
      exitReason:
        exitPrice === null ? null : sameExit ? existing!.exitReason : 'manual',
      exitedAt:
        exitPrice === null ? null : sameExit ? existing!.exitedAt : new Date(),
      notes: data.notes || null,
    };
    const trade = await prisma.userTrade.upsert({
      where: { userId_predictionId: { userId, predictionId } },
      create: { userId, predictionId, ...fields },
      update: fields,
    });
    res.json(toTrade(trade, prediction));
  })
);

router.delete(
  '/:predictionId',
  asyncRoute(async (req, res) => {
    const predictionId = Number(req.params.predictionId);
    if (!Number.isInteger(predictionId))
      return res.status(400).json({ error: 'Unknown signal.' });
    await prisma.userTrade.deleteMany({
      where: { userId: Number(req.user?.sub), predictionId },
    });
    res.status(204).end();
  })
);

export default router;
