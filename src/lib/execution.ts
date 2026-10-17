import { prisma } from './prisma.js';
import { pipSize } from './market.js';
import type { Direction, PairCode } from './model.js';
import { EXECUTION_COST_PIPS } from './risk.js';

// ---- Broker-aware execution data ------------------------------------------------
//
// Live bid/ask comes from MT5 terminals running the FXSignal Sync EA (any
// user's, including a house terminal on a free demo account). Twelve Data
// candles carry no bid/ask, so without a fresh sample there is no live
// spread check — the engine says so rather than guessing.

/** A spread above this (pips) is abnormal: about twice a typical retail spread. */
export const MAX_SPREAD_PIPS: Record<PairCode, number> = {
  'EUR/USD': 2.0,
  'USD/JPY': 2.5,
};
/** Samples older than this are not "live". */
export const SPREAD_FRESH_MS = 3 * 60_000;
/** One stored sample per terminal and pair per this interval. */
const SAMPLE_EVERY_MS = 60_000;
/** Samples are kept this long. */
const KEEP_MS = 14 * 86_400_000;

export interface Quote {
  pairCode: PairCode;
  bid: number;
  ask: number;
  /** ms */
  at: number;
}

export function spreadPips(pair: PairCode, bid: number, ask: number): number {
  return Number(((ask - bid) / pipSize(pair)).toFixed(2));
}

/** Stores quotes from one terminal, at most one per pair per minute. */
export async function recordQuotes(
  quotes: Quote[],
  source: { userId: number; broker: string | null }
) {
  for (const q of quotes) {
    if (!(q.ask >= q.bid) || q.bid <= 0) continue;
    const last = await prisma.spreadSample.findFirst({
      where: { pairCode: q.pairCode, userId: source.userId },
      orderBy: { at: 'desc' },
      select: { at: true },
    });
    if (last && q.at - last.at.getTime() < SAMPLE_EVERY_MS) continue;
    await prisma.spreadSample.create({
      data: {
        pairCode: q.pairCode,
        bid: q.bid,
        ask: q.ask,
        spreadPips: spreadPips(q.pairCode, q.bid, q.ask),
        at: new Date(q.at),
        broker: source.broker,
        userId: source.userId,
      },
    });
  }
}

export interface LiveSpread {
  pairCode: PairCode;
  /** Median of the fresh samples across terminals. */
  spreadPips: number;
  at: string;
  samples: number;
  /** Above MAX_SPREAD_PIPS. */
  wide: boolean;
  /** The cost the engine assumes for comparison. */
  assumedCostPips: number;
}

/** The current spread for a pair from fresh samples, or null when there are none. */
export async function liveSpread(
  pair: PairCode,
  now = new Date()
): Promise<LiveSpread | null> {
  const rows = await prisma.spreadSample.findMany({
    where: { pairCode: pair, at: { gte: new Date(now.getTime() - SPREAD_FRESH_MS) } },
    orderBy: { at: 'desc' },
    take: 50,
  });
  if (rows.length === 0) return null;
  // Newest sample per terminal, then the median across terminals.
  const latest = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.userId ?? 'x'}:${r.broker ?? ''}`;
    if (!latest.has(key)) latest.set(key, Number(r.spreadPips));
  }
  const values = [...latest.values()].sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  return {
    pairCode: pair,
    spreadPips: median,
    at: rows[0].at.toISOString(),
    samples: values.length,
    wide: median > MAX_SPREAD_PIPS[pair],
    assumedCostPips: EXECUTION_COST_PIPS[pair],
  };
}

export async function pruneSpreadSamples(now = new Date()) {
  await prisma.spreadSample.deleteMany({
    where: { at: { lt: new Date(now.getTime() - KEEP_MS) } },
  });
}

/**
 * Slippage of a real fill against the price the signal filled at, in pips.
 * Positive = a worse price than the signal (paid more on a buy, got less on
 * a sell); negative = better.
 */
export function slippagePips(
  pair: PairCode,
  side: Direction,
  intended: number,
  actual: number
): number {
  const diff = side === 'LONG' ? actual - intended : intended - actual;
  return Number((diff / pipSize(pair)).toFixed(1));
}
