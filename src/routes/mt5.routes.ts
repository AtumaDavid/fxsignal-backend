import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  aggregatePositions,
  matchSignal,
  pairFromSymbol,
  type Mt5Position,
} from '../lib/mt5.js';
import { roundToPip } from '../lib/market.js';
import { asyncRoute } from '../middleware/asyncRoute.js';
import type { PairCode } from '../lib/model.js';

function hashKey(key: string) {
  return createHash('sha256').update(key).digest('hex');
}

// ---- Signed-in user: manage the link ------------------------------------------

export const mt5Router = Router();

mt5Router.get(
  '/',
  asyncRoute(async (req, res) => {
    const link = await prisma.mt5Link.findUnique({
      where: { userId: Number(req.user?.sub) },
    });
    res.json({
      linked: Boolean(link),
      link: link
        ? {
            tokenHint: link.tokenHint,
            createdAt: link.createdAt.toISOString(),
            lastSyncAt: link.lastSyncAt?.toISOString() ?? null,
            lastAccount: link.lastAccount,
            lastBroker: link.lastBroker,
            lastPositions: link.lastPositions,
            lastMatched: link.lastMatched,
          }
        : null,
    });
  })
);

/** Creates (or replaces) the sync key. The key is returned once. */
mt5Router.post(
  '/key',
  asyncRoute(async (req, res) => {
    const userId = Number(req.user?.sub);
    const key = `fxs_${randomBytes(24).toString('base64url')}`;
    const data = { tokenHash: hashKey(key), tokenHint: key.slice(-4) };
    await prisma.mt5Link.upsert({
      where: { userId },
      create: { userId, ...data },
      update: {
        ...data,
        createdAt: new Date(),
        lastSyncAt: null,
        lastAccount: null,
        lastBroker: null,
        lastPositions: null,
        lastMatched: null,
      },
    });
    res.status(201).json({ key });
  })
);

mt5Router.delete(
  '/',
  asyncRoute(async (req, res) => {
    await prisma.mt5Link.deleteMany({
      where: { userId: Number(req.user?.sub) },
    });
    res.status(204).end();
  })
);

// ---- The EA: sync positions with the key ------------------------------------------

export const mt5SyncRouter = Router();

const price = z.coerce.number().finite().nonnegative();
const positionSchema = z.object({
  id: z.coerce.string().max(40),
  symbol: z.string().max(40),
  side: z.enum(['BUY', 'SELL']),
  openTime: z.coerce.number().int().positive(),
  openPrice: price,
  volume: z.coerce.number().positive().max(10_000),
  sl: price.default(0),
  tp: price.default(0),
  closedVolume: z.coerce.number().nonnegative().default(0),
  closePrice: price.optional(),
  closeTime: z.coerce.number().int().positive().optional(),
  profit: z.coerce.number().finite().optional(),
});
const syncSchema = z.object({
  account: z.coerce.string().max(40).optional(),
  broker: z.string().max(120).optional(),
  server: z.string().max(120).optional(),
  version: z.string().max(20).optional(),
  positions: z.array(positionSchema).max(500),
});

mt5SyncRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const header = req.headers.authorization ?? '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!key) return res.status(401).json({ error: 'Missing sync key.' });
    const link = await prisma.mt5Link.findUnique({
      where: { tokenHash: hashKey(key) },
    });
    if (!link)
      return res
        .status(401)
        .json({ error: 'Unknown sync key. Create a new one in Settings.' });

    const parsed = syncSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid sync payload.',
      });
    const positions = parsed.data.positions.filter((p) =>
      pairFromSymbol(p.symbol)
    ) as Mt5Position[];

    // Signals that could have been followed by these positions.
    const earliest = positions.length
      ? Math.min(...positions.map((p) => p.openTime)) * 1000
      : Date.now();
    const signals = await prisma.prediction.findMany({
      where: {
        direction: { not: 'NEUTRAL' },
        continuesId: null,
        validFrom: { gte: new Date(earliest - 2 * 86_400_000) },
      },
      select: {
        id: true,
        pairCode: true,
        direction: true,
        validFrom: true,
        expiresAt: true,
      },
    });

    const bySignal = new Map<number, Mt5Position[]>();
    let unmatched = 0;
    for (const position of positions) {
      const signal = matchSignal(position, signals);
      if (!signal) {
        unmatched += 1;
        continue;
      }
      bySignal.set(signal.id, [...(bySignal.get(signal.id) ?? []), position]);
    }

    let written = 0;
    for (const [predictionId, group] of bySignal) {
      const fill = aggregatePositions(group);
      const pair = pairFromSymbol(group[0].symbol) as PairCode;
      const round = (v: number | null) =>
        v === null ? null : roundToPip(pair, v);
      const fields = {
        side: fill.side,
        entryPrice: Number(fill.entryPrice.toFixed(6)),
        exitPrice:
          fill.exitPrice === null ? null : Number(fill.exitPrice.toFixed(6)),
        lots: fill.lots,
        stopPrice: round(fill.stopPrice),
        targetPrice: round(fill.targetPrice),
        exitedAt: fill.exitedAt,
        exitReason: fill.exitPrice === null ? null : 'mt5',
        source: 'mt5',
        externalRef: fill.externalRef,
      };
      await prisma.userTrade.upsert({
        where: { userId_predictionId: { userId: link.userId, predictionId } },
        // Logged when it was opened, so "trades today" counts it correctly.
        create: {
          userId: link.userId,
          predictionId,
          createdAt: fill.openedAt,
          ...fields,
        },
        update: fields,
      });
      written += 1;
    }

    await prisma.mt5Link.update({
      where: { id: link.id },
      data: {
        lastSyncAt: new Date(),
        lastAccount: parsed.data.account ?? null,
        lastBroker: parsed.data.broker ?? null,
        lastPositions: positions.length,
        lastMatched: positions.length - unmatched,
      },
    });
    res.json({
      positions: positions.length,
      matched: positions.length - unmatched,
      unmatched,
      trades: written,
    });
  })
);
