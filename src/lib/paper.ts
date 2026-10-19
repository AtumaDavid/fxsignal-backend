import { prisma } from './prisma.js';
import { candleTime } from './liveData.js';
import { peekStale } from './rateCache.js';
import type { PairCode, ReasonCode } from './model.js';
import { EXECUTION_COST_PIPS, blackoutsFromJson } from './risk.js';
import type { Candle } from './technical.js';
import {
  finalTarget,
  noPositionReason,
  replayPath,
  settleFromPath,
  tradeHoldUntil,
  type DeterministicSignal,
} from './predictions.js';
import type { StrategySnapshot } from './strategy.js';

// ---- Forward paper trading -----------------------------------------------------
//
// A candidate model (by default the zone model) runs beside the live engine
// at every window start, on the same candles (no extra provider credits
// unless it finds a trade and needs fresh M15). Its trades are recorded here,
// never published, and settled from the cached candles like live signals —
// so it builds an out-of-sample record before anyone trades it (spec, 9).
// Differences from live: no model review, no H1 checkpoint (cancel / early
// exit), no portfolio rules.

/** The model paper-traded: PAPER_LEVEL_MODEL (default "zones"; "off" disables). */
export function paperModel(liveModel: 'atr' | 'zones'): 'atr' | 'zones' | null {
  const configured = (process.env.PAPER_LEVEL_MODEL ?? 'zones').toLowerCase();
  if (configured === 'off') return null;
  const model = configured === 'atr' ? 'atr' : 'zones';
  return model === liveModel ? null : model;
}

/** Records a paper trade (trades only; stand-asides are not stored). */
export async function recordPaperSignal(input: {
  model: string;
  pair: PairCode;
  windowKey: string;
  session: string;
  validFrom: Date;
  expiresAt: Date;
  signal: DeterministicSignal;
  strategy: StrategySnapshot;
}) {
  const s = input.signal;
  if (s.direction === 'NEUTRAL') return;
  const target3 = finalTarget({ ...s, pairCode: input.pair });
  await prisma.paperSignal
    .create({
      data: {
        model: input.model,
        pairCode: input.pair,
        windowKey: input.windowKey,
        direction: s.direction,
        confidence: s.confidence,
        entryLow: s.entryLow,
        entryHigh: s.entryHigh,
        targetPrice: s.targetPrice,
        target3Price: target3,
        invalidationPrice: s.invalidationPrice,
        stopPips: s.stopPips,
        entryTrigger: s.entryTrigger,
        noEntryWindows: s.blackouts.length ? (s.blackouts as object) : undefined,
        zoneLabel: s.zone?.label ?? null,
        strategy: input.strategy as unknown as object,
        features: s.features as unknown as object,
        session: input.session,
        validFrom: input.validFrom,
        expiresAt: input.expiresAt,
      },
    })
    .catch((error: { code?: string }) => {
      // Already recorded for this window.
      if (error.code !== 'P2002') throw error;
    });
}

const SPAN: Record<'M15' | 'H1', number> = { M15: 15 * 60_000, H1: 3_600_000 };

/** Cached candles (oldest first) covering [from, until), M15 first, else H1. */
async function cachedPath(pair: string, from: number, until: number): Promise<Candle[] | null> {
  for (const tf of ['M15', 'H1'] as const) {
    const cached = await peekStale<Candle[]>(`twelvedata:tf:${pair}:${tf}`).catch(() => null);
    if (!cached?.length) continue;
    const ordered = [...cached]
      .filter((c) => candleTime(c) + SPAN[tf] <= Date.now())
      .sort((a, b) => candleTime(a) - candleTime(b));
    if (!ordered.length || candleTime(ordered[0]) > from) continue;
    return ordered.filter((c) => candleTime(c) + SPAN[tf] > from && candleTime(c) < until);
  }
  return null;
}

/** Settles paper trades whose result is known. Runs with maintenance. */
export async function settlePaperSignals(now = new Date()) {
  const rows = await prisma.paperSignal.findMany({
    where: { status: 'PENDING', validFrom: { lte: now } },
    take: 50,
  });
  for (const row of rows) {
    const pair = row.pairCode as PairCode;
    const levels = {
      pairCode: row.pairCode,
      direction: row.direction,
      entryLow: Number(row.entryLow),
      entryHigh: Number(row.entryHigh),
      targetPrice: Number(row.targetPrice),
      target3Price: row.target3Price === null ? null : Number(row.target3Price),
      invalidationPrice: Number(row.invalidationPrice),
      entryTrigger: row.entryTrigger === 'TOUCH' ? ('TOUCH' as const) : ('M15_CLOSE' as const),
      blackouts: blackoutsFromJson(row.noEntryWindows),
    };
    const holdUntil = tradeHoldUntil(row.validFrom).getTime();
    const until = Math.min(now.getTime(), holdUntil);
    const candles = await cachedPath(pair, row.validFrom.getTime(), until);
    if (!candles) {
      // The cache no longer reaches back to it: give up after a week.
      if (now.getTime() - row.validFrom.getTime() > 7 * 86_400_000)
        await store(row.id, { status: 'EXPIRED', note: 'Not scored — no cached candles cover it.' });
      continue;
    }
    const path = replayPath(levels, candles);
    const stopPips = Number(row.stopPips);
    const rOf = (pips: number | null) =>
      pips === null || !stopPips
        ? null
        : Number(((pips - EXECUTION_COST_PIPS[pair]) / stopPips).toFixed(2));
    const fill = {
      filledAt: path.filledAt === null ? null : new Date(path.filledAt),
      fillPrice: path.fillPrice,
    };
    if (path.state === 'target' || path.state === 'stopped') {
      const settled = settleFromPath(levels, path, path.closedAt !== null && path.closedAt >= row.expiresAt.getTime());
      await store(row.id, {
        status: settled.status,
        movementPips: settled.movementPips,
        r: rOf(settled.movementPips),
        note: settled.note,
        ...fill,
      });
    } else if (path.state === 'waiting' && (now >= row.expiresAt || path.voidReason)) {
      await store(row.id, {
        status: 'EXPIRED',
        reasonCode: noPositionReason(path),
        note: 'No position was taken.',
      });
    } else if (path.state === 'running' && now.getTime() >= holdUntil) {
      await store(row.id, {
        status: 'EXPIRED',
        movementPips: path.pips,
        r: rOf(path.pips),
        note: 'Still open at the Friday close — marked to the last price.',
        ...fill,
      });
    } else if (path.state === 'running' && fill.filledAt) {
      // Keep the fill so the trade survives the M15 cache rolling over.
      await prisma.paperSignal.update({ where: { id: row.id }, data: fill }).catch(() => undefined);
    }
  }
}

async function store(
  id: number,
  data: {
    status: string;
    movementPips?: number | null;
    r?: number | null;
    note: string;
    reasonCode?: ReasonCode;
    filledAt?: Date | null;
    fillPrice?: number | null;
  }
) {
  await prisma.paperSignal
    .update({ where: { id }, data: { ...data, settledAt: new Date() } })
    .catch((error) =>
      console.warn('Paper settlement failed.', error instanceof Error ? error.message : error)
    );
}
