import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { withCredits } from './rateCache.js';
import { candleTime, type LiveMarketEvent } from './liveData.js';
import {
  PAIRS,
  WINDOW_SCHEDULE,
  pipSize,
  sessionInfo,
  tradingWindowAt,
} from './market.js';
import {
  INTRADAY_TIMEFRAMES,
  buildDeterministicSignal,
  decideOnH1Close,
  finalTarget,
  replayPath,
  settleFromPath,
  tradeHoldUntil,
} from './predictions.js';
import {
  analyzeTimeframe,
  intradayConfluence,
  type Candle,
  type Timeframe,
  type TimeframeView,
} from './technical.js';
import type { PairCode } from './model.js';

/**
 * Backtest: replays the rule engine over past months exactly as it runs live
 * — a read at each session window from the candles closed by then, the same
 * entry zone / stop / three targets, the same M15 replay and H1 checkpoint —
 * and scores every trade the way the track record does.
 *
 * Differences from live, stated on the results page:
 * - rules only (no model review);
 * - one trade per pair per window (no early re-check after a close);
 * - a window is skipped while the pair's previous trade is still open;
 * - news penalty only where the calendar was already stored.
 */

const SPAN: Record<Timeframe, number> = {
  MONTHLY: 30 * 86_400_000,
  WEEKLY: 7 * 86_400_000,
  DAILY: 86_400_000,
  H4: 4 * 3_600_000,
  H1: 3_600_000,
  M15: 15 * 60_000,
};
/** Same lookbacks the live engine fetches. */
const BARS: Partial<Record<Timeframe, number>> = {
  DAILY: 180,
  H4: 180,
  H1: 200,
  M15: 192,
};
const INTERVAL: Partial<Record<Timeframe, string>> = {
  DAILY: '1day',
  H4: '4h',
  H1: '1h',
  M15: '15min',
};
/** Extra history before the first window so every lookback is full. */
const WARMUP_DAYS: Partial<Record<Timeframe, number>> = {
  DAILY: 300,
  H4: 50,
  H1: 15,
  M15: 4,
};
const PAGE = 5000;

// ---- History download (file-cached, so a re-run costs no credits) ----------

const HISTORY_DIR = resolve(process.cwd(), '.cache', 'history');

function fmt(date: Date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

async function fetchPage(
  pair: PairCode,
  tf: Timeframe,
  from: Date,
  to: Date
): Promise<Candle[]> {
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) throw new Error('TWELVE_DATA_API_KEY is not configured.');
  const query = new URLSearchParams({
    symbol: pair,
    interval: INTERVAL[tf]!,
    start_date: fmt(from),
    end_date: fmt(to),
    outputsize: String(PAGE),
    timezone: 'UTC',
    apikey: key,
  });
  const body = await withCredits(1, async () => {
    const response = await fetch(
      `https://api.twelvedata.com/time_series?${query.toString()}`,
      { signal: AbortSignal.timeout(30_000) }
    );
    return (await response.json()) as {
      status?: string;
      message?: string;
      values?: Record<string, string>[];
    };
  });
  if (body.status === 'error')
    throw new Error(`Twelve Data: ${body.message ?? 'request failed'}`);
  return (body.values ?? [])
    .map((v) => ({
      datetime: v.datetime,
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
    }))
    .filter((c) =>
      [c.open, c.high, c.low, c.close].every((n) => Number.isFinite(n))
    );
}

/** Oldest-first candles for [from, to], paging backwards 5,000 at a time. */
export async function fetchHistory(
  pair: PairCode,
  tf: Timeframe,
  from: Date,
  to: Date
): Promise<Candle[]> {
  const file = resolve(
    HISTORY_DIR,
    `${pair.replace('/', '')}-${tf}-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.json`
  );
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Candle[];
  } catch {
    // Not downloaded yet.
  }
  const byTime = new Map<number, Candle>();
  let cursor = to;
  for (let page = 0; page < 10; page += 1) {
    const candles = await fetchPage(pair, tf, from, cursor);
    for (const c of candles) byTime.set(candleTime(c), c);
    if (candles.length < PAGE) break;
    const oldest = Math.min(...candles.map(candleTime));
    if (oldest <= from.getTime()) break;
    cursor = new Date(oldest - 1000);
  }
  const ordered = [...byTime.values()].sort(
    (a, b) => candleTime(a) - candleTime(b)
  );
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(ordered), 'utf8');
  return ordered;
}

// ---- Simulation --------------------------------------------------------------

export type HistorySet = Partial<Record<Timeframe, Candle[]>>;

export interface BacktestTrade {
  pairCode: PairCode;
  session: string;
  direction: 'LONG' | 'SHORT';
  confidence: number;
  publishedAt: string;
  entryLow: number;
  entryHigh: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3: number;
  stopPips: number;
  /** HIT · MISSED · CLOSED_EARLY · EXPIRED (no fill or marked to close) · CANCELLED · OPEN (still running when the data ends). */
  status: string;
  filled: boolean;
  closedAt: string | null;
  pips: number | null;
  r: number | null;
  tpHits: number;
  note: string;
}

/** Index of the newest candle that has closed by `t` (oldest-first input). */
function lastClosedIndex(candles: Candle[], tf: Timeframe, t: number) {
  let lo = 0;
  let hi = candles.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candleTime(candles[mid]) + SPAN[tf] <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The `count` candles closed by `t`, newest first (as the engine expects). */
function closedBy(candles: Candle[], tf: Timeframe, t: number, count: number) {
  const end = lastClosedIndex(candles, tf, t);
  if (end < 0) return [];
  return candles.slice(Math.max(0, end - count + 1), end + 1).reverse();
}

/**
 * Plays one published trade forward: M15 replay for fills, targets and stops;
 * the H1 checkpoint at every H1 close (cancel before entry, early exit before
 * TP1) — the same functions the live server uses.
 */
function simulateTrade(
  pair: PairCode,
  levels: Parameters<typeof replayPath>[0],
  publishedAt: number,
  windowEnd: number,
  history: HistorySet,
  viewAt: (tf: Timeframe, t: number) => TimeframeView | null
): Omit<
  BacktestTrade,
  | 'pairCode'
  | 'session'
  | 'direction'
  | 'confidence'
  | 'publishedAt'
  | 'entryLow'
  | 'entryHigh'
  | 'stop'
  | 'tp1'
  | 'tp2'
  | 'tp3'
  | 'stopPips'
> {
  const m15 = history.M15 ?? [];
  const holdUntil = tradeHoldUntil(new Date(publishedAt)).getTime();
  const dataEnd = m15.length ? candleTime(m15[m15.length - 1]) + SPAN.M15 : 0;
  const startIdx = m15.findIndex((c) => candleTime(c) + SPAN.M15 > publishedAt);
  const mid = (levels.entryLow + levels.entryHigh) / 2;
  const signed = (price: number) =>
    Number(
      (
        (levels.direction === 'LONG' ? price - mid : mid - price) /
        pipSize(pair)
      ).toFixed(1)
    );
  const open = {
    status: 'OPEN',
    filled: false,
    closedAt: null,
    pips: null,
    r: null,
    tpHits: 0,
    note: 'Still open when the data ends.',
  };
  if (startIdx < 0) return open;

  const firstCheck = Math.floor(publishedAt / SPAN.H1) * SPAN.H1 + SPAN.H1;
  for (let t = firstCheck; ; t += SPAN.H1) {
    const limit = Math.min(t, holdUntil);
    const candles: Candle[] = [];
    for (let i = startIdx; i < m15.length; i += 1) {
      if (candleTime(m15[i]) + SPAN.M15 > limit) break;
      candles.push(m15[i]);
    }
    const path = replayPath(levels, candles);
    const filled = path.filledAt !== null;
    const after = (path.closedAt ?? 0) >= windowEnd;

    if (path.state === 'target' || path.state === 'stopped') {
      const s = settleFromPath(levels, path, after);
      return {
        status: s.status,
        filled,
        closedAt: path.closedAt ? new Date(path.closedAt).toISOString() : null,
        pips: s.movementPips,
        r: null,
        tpHits: path.tpHits,
        note: s.note,
      };
    }
    if (path.state === 'waiting' && limit >= windowEnd)
      return {
        status: 'EXPIRED',
        filled: false,
        closedAt: new Date(windowEnd).toISOString(),
        pips: null,
        r: null,
        tpHits: 0,
        note: 'Price never traded into the entry zone — no position was taken.',
      };
    if (limit >= holdUntil) {
      return {
        status: 'EXPIRED',
        filled,
        closedAt: new Date(holdUntil).toISOString(),
        pips: path.pips,
        r: null,
        tpHits: path.tpHits,
        note: 'Still open at the Friday close — closed there at the last price.',
      };
    }
    if (t > dataEnd) return open;

    // H1 checkpoint (before entry, or after entry until TP1).
    if (
      (path.state === 'waiting' ||
        (path.state === 'running' && path.tpHits === 0)) &&
      levels.direction !== 'NEUTRAL'
    ) {
      const h1 = viewAt('H1', t);
      const h4 = viewAt('H4', t);
      const daily = viewAt('DAILY', t);
      const h1Candle = closedBy(history.H1 ?? [], 'H1', t, 1)[0];
      const context = h1
        ? intradayConfluence(
            [daily, h4, h1].filter((v): v is TimeframeView => Boolean(v))
          )
        : null;
      if (h1 && h1Candle && context) {
        const decision = decideOnH1Close({
          direction: levels.direction as 'LONG' | 'SHORT',
          state: path.state,
          entryLow: levels.entryLow,
          entryHigh: levels.entryHigh,
          invalidationPrice: levels.invalidationPrice,
          h1Close: h1Candle.close,
          h1Score: h1.biasScore,
          h4Score: h4?.biasScore ?? null,
          contextScore: context.score,
        });
        if (decision.action === 'cancel')
          return {
            status: 'CANCELLED',
            filled: false,
            closedAt: new Date(t).toISOString(),
            pips: null,
            r: null,
            tpHits: 0,
            note: decision.reason,
          };
        if (decision.action === 'exit')
          return {
            status: 'CLOSED_EARLY',
            filled: true,
            closedAt: new Date(t).toISOString(),
            pips: signed(h1Candle.close),
            r: null,
            tpHits: 0,
            note: decision.reason,
          };
      }
    }
  }
}

/**
 * Every session window of every trading day in [from, to) for one pair.
 * Pure (no I/O): history and events are passed in.
 */
export function simulatePair(
  pair: PairCode,
  history: HistorySet,
  events: LiveMarketEvent[],
  from: Date,
  to: Date
): { trades: BacktestTrade[]; standAsides: number; skippedOpen: number } {
  const trades: BacktestTrade[] = [];
  let standAsides = 0;
  let skippedOpen = 0;
  let busyUntil = 0;

  // Views only change when a new candle closes on that timeframe.
  const viewCache = new Map<string, TimeframeView | null>();
  const viewAt = (tf: Timeframe, t: number) => {
    const series = history[tf] ?? [];
    const idx = lastClosedIndex(series, tf, t);
    const key = `${tf}:${idx}`;
    if (!viewCache.has(key)) {
      const candles = closedBy(series, tf, t, BARS[tf] ?? 200);
      viewCache.set(
        key,
        candles.length >= 5 ? analyzeTimeframe(pair, tf, candles) : null
      );
    }
    return viewCache.get(key) ?? null;
  };

  const day = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())
  );
  for (; day < to; day.setUTCDate(day.getUTCDate() + 1)) {
    for (const slot of WINDOW_SCHEDULE) {
      const start = day.getTime() + slot.startHour * 3_600_000;
      if (start < from.getTime() || start >= to.getTime()) continue;
      const window = tradingWindowAt(new Date(start));
      if (!window || window.start.getTime() !== start) continue;
      if (start < busyUntil) {
        skippedOpen += 1;
        continue;
      }
      const mtf = Object.fromEntries(
        (['MONTHLY', 'WEEKLY', ...INTRADAY_TIMEFRAMES] as Timeframe[]).map(
          (tf) => [tf, closedBy(history[tf] ?? [], tf, start, BARS[tf] ?? 0)]
        )
      ) as Record<Timeframe, Candle[]>;
      if (mtf.M15.length < 20 || mtf.H1.length < 20) continue;

      const windowEvents = events.filter(
        (e) =>
          e.eventDate.getTime() >= start - 30 * 60_000 &&
          e.eventDate.getTime() <= window.end.getTime()
      );
      const signal = buildDeterministicSignal(
        pair,
        mtf,
        windowEvents,
        window.label,
        sessionInfo(window.start).playbookHint,
        window.start,
        { windowEnd: window.end, strict: window.strict }
      );
      if (!signal) continue;
      if (signal.direction === 'NEUTRAL') {
        standAsides += 1;
        continue;
      }
      const levels = {
        pairCode: pair,
        direction: signal.direction,
        entryLow: signal.entryLow,
        entryHigh: signal.entryHigh,
        targetPrice: signal.targetPrice,
        invalidationPrice: signal.invalidationPrice,
        target3Price: finalTarget({ ...signal, pairCode: pair }),
      };
      const mid = (levels.entryLow + levels.entryHigh) / 2;
      const result = simulateTrade(
        pair,
        levels,
        start,
        window.end.getTime(),
        history,
        viewAt
      );
      const r =
        result.pips !== null && signal.stopPips > 0
          ? Number((result.pips / signal.stopPips).toFixed(2))
          : null;
      trades.push({
        pairCode: pair,
        session: window.label,
        direction: signal.direction as 'LONG' | 'SHORT',
        confidence: signal.confidence,
        publishedAt: window.start.toISOString(),
        entryLow: levels.entryLow,
        entryHigh: levels.entryHigh,
        stop: levels.invalidationPrice,
        tp1: mid + (mid - levels.invalidationPrice),
        tp2: levels.targetPrice,
        tp3: levels.target3Price ?? levels.targetPrice,
        stopPips: signal.stopPips,
        ...result,
        r,
      });
      // A filled trade blocks new windows on this pair until it closes.
      if (result.filled)
        busyUntil = result.closedAt
          ? new Date(result.closedAt).getTime()
          : Number.MAX_SAFE_INTEGER;
    }
  }
  return { trades, standAsides, skippedOpen };
}

// ---- Summary -------------------------------------------------------------------

export interface BacktestGroup {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  netR: number;
}

export interface BacktestSummary {
  from: string;
  to: string;
  /** Filled trades with a result. */
  trades: number;
  wins: number;
  losses: number;
  earlyExits: number;
  timeExits: number;
  notTriggered: number;
  cancelled: number;
  standAsides: number;
  skippedOpen: number;
  winRate: number | null;
  netR: number;
  netPips: number;
  avgR: number | null;
  profitFactor: number | null;
  maxDrawdownR: number;
  longestLosingStreak: number;
  byPair: BacktestGroup[];
  bySession: BacktestGroup[];
  byMonth: BacktestGroup[];
  curve: { at: string; r: number }[];
}

const SCORED = new Set(['HIT', 'MISSED', 'CLOSED_EARLY', 'EXPIRED']);

function groupBy(trades: BacktestTrade[], keyOf: (t: BacktestTrade) => string) {
  const map = new Map<string, BacktestGroup>();
  for (const t of trades) {
    const key = keyOf(t);
    const g = map.get(key) ?? { key, trades: 0, wins: 0, losses: 0, netR: 0 };
    g.trades += 1;
    if (t.status === 'HIT') g.wins += 1;
    if (t.status === 'MISSED') g.losses += 1;
    g.netR += t.r ?? 0;
    map.set(key, g);
  }
  return [...map.values()].map((g) => ({
    ...g,
    netR: Number(g.netR.toFixed(2)),
  }));
}

export function summarize(
  all: BacktestTrade[],
  from: Date,
  to: Date,
  extra: { standAsides: number; skippedOpen: number }
): BacktestSummary {
  const closed = all
    .filter((t) => t.filled && SCORED.has(t.status) && t.r !== null)
    .sort((a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? ''));
  const wins = closed.filter((t) => t.status === 'HIT').length;
  const losses = closed.filter((t) => t.status === 'MISSED').length;
  const netR = closed.reduce((s, t) => s + (t.r ?? 0), 0);
  const gains = closed
    .filter((t) => (t.r ?? 0) > 0)
    .reduce((s, t) => s + t.r!, 0);
  const pains = closed
    .filter((t) => (t.r ?? 0) < 0)
    .reduce((s, t) => s - t.r!, 0);

  let running = 0;
  let peak = 0;
  let maxDd = 0;
  let streak = 0;
  let longest = 0;
  const curve = closed.map((t) => {
    running += t.r ?? 0;
    peak = Math.max(peak, running);
    maxDd = Math.max(maxDd, peak - running);
    streak = (t.r ?? 0) < 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
    return { at: t.closedAt!, r: Number(running.toFixed(2)) };
  });

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    trades: closed.length,
    wins,
    losses,
    earlyExits: closed.filter((t) => t.status === 'CLOSED_EARLY').length,
    timeExits: closed.filter((t) => t.status === 'EXPIRED').length,
    notTriggered: all.filter((t) => t.status === 'EXPIRED' && !t.filled).length,
    cancelled: all.filter((t) => t.status === 'CANCELLED').length,
    standAsides: extra.standAsides,
    skippedOpen: extra.skippedOpen,
    winRate:
      wins + losses > 0
        ? Number(((wins / (wins + losses)) * 100).toFixed(1))
        : null,
    netR: Number(netR.toFixed(2)),
    netPips: Number(closed.reduce((s, t) => s + (t.pips ?? 0), 0).toFixed(1)),
    avgR: closed.length ? Number((netR / closed.length).toFixed(2)) : null,
    profitFactor: pains > 0 ? Number((gains / pains).toFixed(2)) : null,
    maxDrawdownR: Number(maxDd.toFixed(2)),
    longestLosingStreak: longest,
    byPair: groupBy(closed, (t) => t.pairCode),
    bySession: groupBy(closed, (t) => t.session),
    byMonth: groupBy(closed, (t) =>
      (t.closedAt ?? t.publishedAt).slice(0, 7)
    ).sort((a, b) => a.key.localeCompare(b.key)),
    curve,
  };
}

// ---- Runs ------------------------------------------------------------------------

let running: Promise<void> | null = null;

export function backtestRunning() {
  return running !== null;
}

/**
 * Downloads the history (≈7 provider credits per pair the first time, cached
 * after that), simulates both pairs and stores the run. Returns the run id;
 * the work continues in the background.
 */
export async function startBacktest(months: number): Promise<number> {
  if (running) throw new Error('A backtest is already running.');
  const to = new Date();
  to.setUTCHours(0, 0, 0, 0);
  const from = new Date(to);
  from.setUTCMonth(from.getUTCMonth() - months);
  const run = await prisma.backtestRun.create({
    data: {
      status: 'RUNNING',
      months,
      from,
      to,
    },
  });
  running = (async () => {
    try {
      const events = (
        await prisma.marketEvent.findMany({
          where: { eventDate: { gte: from, lte: to } },
        })
      ).map((e) => ({
        externalId: e.externalId,
        currency: e.currency,
        title: e.title,
        eventDate: e.eventDate,
        impact: e.impact,
        forecast: e.forecast,
        previousValue: e.previousValue,
      })) as LiveMarketEvent[];
      const trades: BacktestTrade[] = [];
      let standAsides = 0;
      let skippedOpen = 0;
      for (const pair of PAIRS) {
        const history: HistorySet = {};
        for (const tf of INTRADAY_TIMEFRAMES) {
          const start = new Date(
            from.getTime() - (WARMUP_DAYS[tf] ?? 10) * 86_400_000
          );
          history[tf] = await fetchHistory(pair, tf, start, to);
        }
        const result = simulatePair(pair, history, events, from, to);
        trades.push(...result.trades);
        standAsides += result.standAsides;
        skippedOpen += result.skippedOpen;
      }
      trades.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
      const summary = summarize(trades, from, to, { standAsides, skippedOpen });
      await prisma.backtestRun.update({
        where: { id: run.id },
        data: {
          status: 'DONE',
          finishedAt: new Date(),
          summary: summary as unknown as Prisma.InputJsonValue,
          trades: trades as unknown as Prisma.InputJsonValue,
        },
      });
      console.info(
        `Backtest #${run.id}: ${summary.trades} trades, ${summary.netR}R over ${months} months.`
      );
    } catch (error) {
      console.warn(
        'Backtest failed.',
        error instanceof Error ? error.message : error
      );
      await prisma.backtestRun
        .update({
          where: { id: run.id },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            error:
              error instanceof Error
                ? error.message.slice(0, 500)
                : String(error),
          },
        })
        .catch(() => undefined);
    } finally {
      running = null;
    }
  })();
  return run.id;
}
