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
  CONFIRM_WINDOW_BARS,
  MAX_SIGNALS_PER_WINDOW,
  REARM_MIN_LEFT_MS,
  SETUP_COOLDOWN_MS,
  finalTarget,
  lifecycleStage,
  liveFilters,
  liveLevelModel,
  liveScanMode,
  liveStrategy,
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
import type { PairCode, ReasonCode } from './model.js';
import type { SignalFeatures } from './regime.js';
import { strategySnapshot } from './strategy.js';
import { fetchOandaHistory } from './oanda.js';
import {
  COMMISSION_PIPS,
  SLIPPAGE_PIPS,
  EXECUTION_COST_PIPS,
  monteCarlo,
  portfolioBlock,
  type MonteCarlo,
} from './risk.js';

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
  for (let page = 0; page < 15; page += 1) {
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

/** Every pair's intraday history for [from, to] plus warm-up (cached on disk). */
export async function loadHistories(
  from: Date,
  to: Date,
  /** oanda: bid/ask history (real spreads); twelvedata: single-price candles. */
  source: 'twelvedata' | 'oanda' = 'twelvedata'
): Promise<Partial<Record<PairCode, HistorySet>>> {
  const out: Partial<Record<PairCode, HistorySet>> = {};
  for (const pair of PAIRS) {
    const history: HistorySet = {};
    for (const tf of INTRADAY_TIMEFRAMES) {
      const start = new Date(
        from.getTime() - (WARMUP_DAYS[tf] ?? 10) * 86_400_000
      );
      history[tf] =
        source === 'oanda'
          ? await fetchOandaHistory(pair, tf, start, to)
          : await fetchHistory(pair, tf, start, to);
    }
    out[pair] = history;
  }
  return out;
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
  /** Net of costPips. */
  pips: number | null;
  /** Spread + slippage deducted from this trade (0 when not filled). */
  costPips: number;
  /** pips ÷ stopPips, after costs. */
  r: number | null;
  tpHits: number;
  note: string;
  /** Why it never became a position, or was cancelled. */
  reasonCode: ReasonCode | null;
  /** Market conditions at publish (regime.ts). */
  features: SignalFeatures | null;
  /** H1 ATR at publish, in pips. */
  atrPips: number | null;
  /** The engine's fill (for exit research), when it filled. */
  fillPrice?: number | null;
  filledAt?: string | null;
  /** Same pair + direction + structure = same setup (duplicate guard). */
  setupKey?: string | null;
  /** Published at the window start, or by a later H1 scan. */
  scan?: 'start' | 'rescan';
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
  | 'costPips'
  | 'features'
  | 'atrPips'
> & { fillSpreadPips?: number | null } {
  const m15 = history.M15 ?? [];
  const holdUntil = tradeHoldUntil(new Date(publishedAt)).getTime();
  const dataEnd = m15.length ? candleTime(m15[m15.length - 1]) + SPAN.M15 : 0;
  const startIdx = m15.findIndex((c) => candleTime(c) + SPAN.M15 > publishedAt);
  const signed = (price: number, fill: number) =>
    Number(
      (
        (levels.direction === 'LONG' ? price - fill : fill - price) /
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
    reasonCode: null,
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

    // The real spread at the fill, on bid/ask history.
    const fillCandle =
      path.filledAt === null ? undefined : m15.find((c) => candleTime(c) === path.filledAt);
    const fillSpreadPips =
      fillCandle?.spread === undefined ? null : fillCandle.spread / pipSize(pair);
    const fill = {
      fillPrice: path.fillPrice,
      filledAt: path.filledAt === null ? null : new Date(path.filledAt).toISOString(),
    };
    if (path.state === 'target' || path.state === 'stopped') {
      const s = settleFromPath(levels, path, after);
      return {
        fillSpreadPips,
        ...fill,
        status: s.status,
        filled,
        closedAt: path.closedAt ? new Date(path.closedAt).toISOString() : null,
        pips: s.movementPips,
        r: null,
        tpHits: path.tpHits,
        note: s.note,
        reasonCode: null,
      };
    }
    if (path.state === 'waiting' && (limit >= windowEnd || path.voidReason)) {
      const s = settleFromPath(levels, path);
      return {
        status: 'EXPIRED',
        filled: false,
        closedAt: new Date(windowEnd).toISOString(),
        pips: null,
        r: null,
        tpHits: 0,
        note: s.note,
        reasonCode: s.reasonCode ?? null,
      };
    }
    if (limit >= holdUntil) {
      return {
        fillSpreadPips,
        ...fill,
        status: 'EXPIRED',
        filled,
        closedAt: new Date(holdUntil).toISOString(),
        pips: path.pips,
        r: null,
        tpHits: path.tpHits,
        note: 'Still open at the Friday close — closed there at the last price.',
        reasonCode: null,
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
            reasonCode: decision.code ?? null,
          };
        if (decision.action === 'exit')
          return {
            fillSpreadPips,
        ...fill,
            status: 'CLOSED_EARLY',
            filled: true,
            closedAt: new Date(t).toISOString(),
            pips: signed(
              h1Candle.close,
              path.fillPrice ?? (levels.entryLow + levels.entryHigh) / 2
            ),
            r: null,
            tpHits: 0,
            note: decision.reason,
            reasonCode: null,
          };
      }
    }
  }
}

export interface PortfolioRules {
  /** Deduct EXECUTION_COST_PIPS from every filled trade. */
  costs?: boolean;
  /** No second trade on the same USD side across the pairs. */
  usdCap?: boolean;
  /** No new trades after DAILY_LOSS_LIMIT_R of closed losses in a UTC day. */
  dailyLossLimit?: boolean;
  /**
   * When pairs are re-read inside a window:
   * - none: only at the window start (the original backtest);
   * - rearm: also at H1 closes after the pair's trade finished (live today);
   * - hourly: also at every H1 close while the pair has no active trade
   *   (London/New York), the spec's hourly scan.
   */
  scans?: ScanMode;
  /** A setup (pair + direction + structure) is not republished within this. */
  setupCooldownMs?: number;
}

export type ScanMode = 'none' | 'rearm' | 'hourly';

export interface SimulationResult {
  trades: BacktestTrade[];
  standAsides: number;
  skippedOpen: number;
  /** Calls not taken because of the USD cap or the daily loss limit. */
  portfolioBlocked: number;
  /** Stand-asides and blocked calls by reason. */
  standAsideReasons: Partial<Record<ReasonCode, number>>;
}

/**
 * Every session window of every trading day in [from, to), for all pairs
 * together so the portfolio rules see both: at each read the pairs' calls
 * are built, the higher-confidence call goes first, and each must pass the
 * duplicate-setup guard, the USD cap and the daily loss limit against trades
 * already published. Reads happen at the window start and, depending on
 * `scans`, at later H1 closes inside London and New York.
 * Pure (no I/O): history and events are passed in.
 */
export function simulatePortfolio(
  histories: Partial<Record<PairCode, HistorySet>>,
  events: LiveMarketEvent[],
  from: Date,
  to: Date,
  /** Engine variant to replay (default: the live engine). */
  engine: Pick<
    NonNullable<Parameters<typeof buildDeterministicSignal>[6]>,
    'levelModel' | 'entryTrigger' | 'requireRoom' | 'zoneSources' | 'filters'
  > = {},
  rules: PortfolioRules = {}
): SimulationResult {
  const use = {
    costs: true,
    usdCap: true,
    dailyLossLimit: true,
    scans: 'none' as ScanMode,
    setupCooldownMs: SETUP_COOLDOWN_MS,
    ...rules,
  };
  const pairs = PAIRS.filter((p) => histories[p]);
  const trades: BacktestTrade[] = [];
  let standAsides = 0;
  let skippedOpen = 0;
  let portfolioBlocked = 0;
  const standAsideReasons: Partial<Record<ReasonCode, number>> = {};
  const countReason = (code: ReasonCode | null) => {
    if (code) standAsideReasons[code] = (standAsideReasons[code] ?? 0) + 1;
  };
  const busyUntil = new Map<PairCode, number>();

  // Views only change when a new candle closes on that timeframe.
  const viewCaches = new Map<PairCode, Map<string, TimeframeView | null>>();
  const viewFor = (pair: PairCode) => {
    const history = histories[pair]!;
    if (!viewCaches.has(pair)) viewCaches.set(pair, new Map());
    const cache = viewCaches.get(pair)!;
    return (tf: Timeframe, t: number) => {
      const series = history[tf] ?? [];
      const idx = lastClosedIndex(series, tf, t);
      const key = `${tf}:${idx}`;
      if (!cache.has(key)) {
        const candles = closedBy(series, tf, t, BARS[tf] ?? 200);
        cache.set(
          key,
          candles.length >= 5 ? analyzeTimeframe(pair, tf, candles) : null
        );
      }
      return cache.get(key) ?? null;
    };
  };
  const endOf = (t: BacktestTrade) =>
    t.closedAt ? Date.parse(t.closedAt) : Number.MAX_SAFE_INTEGER;

  const day = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())
  );
  for (; day < to; day.setUTCDate(day.getUTCDate() + 1)) {
    for (const slot of WINDOW_SCHEDULE) {
      const start = day.getTime() + slot.startHour * 3_600_000;
      if (start < from.getTime() || start >= to.getTime()) continue;
      const window = tradingWindowAt(new Date(start));
      if (!window || window.start.getTime() !== start) continue;
      const windowEnd = window.end.getTime();

      // Read times: the window start, then H1 closes (London / New York).
      const reads = [start];
      if (use.scans !== 'none' && window.rearm)
        for (let t = start + 3_600_000; windowEnd - t >= REARM_MIN_LEFT_MS; t += 3_600_000)
          reads.push(t);

      for (const at of reads) {
        const first = at === start;
        const calls: {
          pair: PairCode;
          signal: NonNullable<ReturnType<typeof buildDeterministicSignal>>;
        }[] = [];
        for (const pair of pairs) {
          if (at < (busyUntil.get(pair) ?? 0)) {
            if (first) skippedOpen += 1;
            continue;
          }
          const inWindow = trades.filter(
            (t) => t.pairCode === pair && Date.parse(t.publishedAt) >= start
          );
          const last = inWindow[inWindow.length - 1];
          let requireH1Aligned = false;
          if (!first) {
            // Something still pending from this window: no new call.
            if (last && endOf(last) > at) continue;
            if (inWindow.length >= MAX_SIGNALS_PER_WINDOW) continue;
            // rearm: only once the pair's trade in this window has finished.
            if (use.scans === 'rearm' && !last) continue;
            // After a loss, cancel or early exit H1 must clearly agree again.
            requireH1Aligned = Boolean(
              last && (last.status !== 'HIT' || last.tpHits < 3)
            );
          }
          const history = histories[pair]!;
          const mtf = Object.fromEntries(
            (['MONTHLY', 'WEEKLY', ...INTRADAY_TIMEFRAMES] as Timeframe[]).map(
              (tf) => [tf, closedBy(history[tf] ?? [], tf, at, BARS[tf] ?? 0)]
            )
          ) as Record<Timeframe, Candle[]>;
          if (mtf.M15.length < 20 || mtf.H1.length < 20) continue;
          const windowEvents = events.filter(
            (e) =>
              e.eventDate.getTime() >= at - 30 * 60_000 &&
              e.eventDate.getTime() <= windowEnd
          );
          const signal = buildDeterministicSignal(
            pair,
            mtf,
            windowEvents,
            window.label,
            sessionInfo(window.start).playbookHint,
            new Date(at),
            {
              windowEnd: window.end,
              strict: window.strict,
              requireH1Aligned,
              ...engine,
            }
          );
          if (!signal) continue;
          if (signal.direction === 'NEUTRAL') {
            if (first) {
              standAsides += 1;
              countReason(signal.reasonCode);
            }
            continue;
          }
          calls.push({ pair, signal });
        }

        calls.sort((a, b) => b.signal.confidence - a.signal.confidence);
        for (const { pair, signal } of calls) {
          // The same setup is not published twice within the cooldown.
          const key = signal.features.setupKey ?? null;
          if (
            key &&
            trades.some(
              (t) =>
                t.setupKey === key &&
                at - Date.parse(t.publishedAt) < use.setupCooldownMs
            )
          ) {
            countReason('DUPLICATE_SETUP');
            continue;
          }
          const dayStart = day.getTime();
          const lostToday = use.dailyLossLimit
            ? trades
                .filter(
                  (t) =>
                    t.filled &&
                    t.r !== null &&
                    t.closedAt &&
                    Date.parse(t.closedAt) >= dayStart &&
                    Date.parse(t.closedAt) <= at
                )
                .reduce((sum, t) => sum + t.r!, 0)
            : 0;
          const active = use.usdCap
            ? trades
                .filter((t) => Date.parse(t.publishedAt) <= at && endOf(t) > at)
                .map((t) => ({ pairCode: t.pairCode, direction: t.direction }))
            : [];
          const block = portfolioBlock(
            { pairCode: pair, direction: signal.direction },
            active,
            lostToday
          );
          if (block) {
            portfolioBlocked += 1;
            countReason(block.code);
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
            entryTrigger: signal.entryTrigger,
            blackouts: signal.blackouts,
          };
          const mid = (levels.entryLow + levels.entryHigh) / 2;
          const result = simulateTrade(
            pair,
            levels,
            at,
            windowEnd,
            histories[pair]!,
            viewFor(pair)
          );
          // Real spread at the fill + slippage on bid/ask history; else the
          // fixed typical cost.
          const { fillSpreadPips, ...outcome } = result;
          const costPips =
            use.costs && result.filled && result.pips !== null
              ? fillSpreadPips != null
                ? Number((fillSpreadPips + SLIPPAGE_PIPS + COMMISSION_PIPS).toFixed(2))
                : EXECUTION_COST_PIPS[pair]
              : 0;
          const pips =
            result.pips === null ? null : Number((result.pips - costPips).toFixed(1));
          const r =
            pips !== null && signal.stopPips > 0
              ? Number((pips / signal.stopPips).toFixed(2))
              : null;
          trades.push({
            pairCode: pair,
            session: window.label,
            direction: signal.direction as 'LONG' | 'SHORT',
            confidence: signal.confidence,
            publishedAt: new Date(at).toISOString(),
            entryLow: levels.entryLow,
            entryHigh: levels.entryHigh,
            stop: levels.invalidationPrice,
            tp1: mid + (mid - levels.invalidationPrice),
            tp2: levels.targetPrice,
            tp3: levels.target3Price ?? levels.targetPrice,
            stopPips: signal.stopPips,
            ...outcome,
            pips,
            costPips,
            r,
            features: signal.features,
            atrPips: signal.atrPips,
            setupKey: key,
            scan: first ? 'start' : 'rescan',
          });
          // A filled trade blocks new reads on this pair until it closes.
          if (result.filled)
            busyUntil.set(
              pair,
              result.closedAt
                ? new Date(result.closedAt).getTime()
                : Number.MAX_SAFE_INTEGER
            );
        }
      }
    }
  }
  return { trades, standAsides, skippedOpen, portfolioBlocked, standAsideReasons };
}

/** One pair on its own (no cross-pair USD cap to apply). */
export function simulatePair(
  pair: PairCode,
  history: HistorySet,
  events: LiveMarketEvent[],
  from: Date,
  to: Date,
  engine: Parameters<typeof simulatePortfolio>[4] = {},
  rules: PortfolioRules = {}
): SimulationResult {
  return simulatePortfolio({ [pair]: history }, events, from, to, engine, rules);
}

// ---- Replay / research mode ------------------------------------------------------

export interface ReplayFrame {
  pair: PairCode;
  /** The instant being replayed (ms): everything shown closed by then. */
  at: number;
  window: { label: string; start: string; end: string } | null;
  /** M15 candles closed by `at`, oldest first (the chart). */
  candles: { time: number; open: number; high: number; low: number; close: number }[];
  /** The call the engine published at the window start, from data closed by then. */
  signal: {
    direction: string;
    confidence: number;
    entryLow: number;
    entryHigh: number;
    stop: number;
    tp1: number;
    tp2: number;
    tp3: number | null;
    reasonCode: string | null;
    notes: string[];
    entryTrigger: string;
    blackouts: { from: number; to: number; title: string }[];
  } | null;
  /** Where that call stood at `at` (no look-ahead). */
  progress: {
    state: string;
    stage: string;
    touchedAt: number | null;
    filledAt: number | null;
    fillPrice: number | null;
    pips: number | null;
    tpHits: number;
  } | null;
  /** The real outcome (looks ahead) — only with reveal. */
  outcome: { status: string; pips: number | null; closedAt: string | null; note: string } | null;
}

/**
 * One frame of the replay: the window around `at`, the signal built from the
 * candles closed at its start, and its state at `at` from the candles closed
 * by then. The final outcome is computed only when `reveal` is set.
 */
export function replayAt(
  pair: PairCode,
  history: HistorySet,
  at: number,
  options: { reveal?: boolean; engine?: Parameters<typeof simulatePortfolio>[4] } = {}
): ReplayFrame {
  const m15 = history.M15 ?? [];
  const candles = closedBy(m15, 'M15', at, 192)
    .reverse()
    .map((c) => ({
      time: Math.floor(candleTime(c) / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
  const window = tradingWindowAt(new Date(at));
  const frame: ReplayFrame = {
    pair,
    at,
    window: window
      ? { label: window.label, start: window.start.toISOString(), end: window.end.toISOString() }
      : null,
    candles,
    signal: null,
    progress: null,
    outcome: null,
  };
  if (!window) return frame;
  const start = window.start.getTime();
  const mtf = Object.fromEntries(
    (['MONTHLY', 'WEEKLY', ...INTRADAY_TIMEFRAMES] as Timeframe[]).map((tf) => [
      tf,
      closedBy(history[tf] ?? [], tf, start, BARS[tf] ?? 0),
    ])
  ) as Record<Timeframe, Candle[]>;
  if (mtf.M15.length < 20 || mtf.H1.length < 20) return frame;
  const signal = buildDeterministicSignal(
    pair,
    mtf,
    [],
    window.label,
    sessionInfo(window.start).playbookHint,
    window.start,
    { windowEnd: window.end, strict: window.strict, ...(options.engine ?? liveLevelModel()) }
  );
  if (!signal) return frame;
  const mid = (signal.entryLow + signal.entryHigh) / 2;
  const levels = {
    pairCode: pair,
    direction: signal.direction,
    entryLow: signal.entryLow,
    entryHigh: signal.entryHigh,
    targetPrice: signal.targetPrice,
    invalidationPrice: signal.invalidationPrice,
    target3Price: finalTarget({ ...signal, pairCode: pair }),
    entryTrigger: signal.entryTrigger,
    blackouts: signal.blackouts,
  };
  frame.signal = {
    direction: signal.direction,
    confidence: signal.confidence,
    entryLow: signal.entryLow,
    entryHigh: signal.entryHigh,
    stop: signal.invalidationPrice,
    tp1: mid + (mid - signal.invalidationPrice),
    tp2: signal.targetPrice,
    tp3: levels.target3Price,
    reasonCode: signal.reasonCode,
    notes: signal.confluence.notes.slice(0, 5),
    entryTrigger: signal.entryTrigger,
    blackouts: signal.blackouts,
  };
  if (signal.direction !== 'NEUTRAL') {
    const sinceStart = m15.filter(
      (c) => candleTime(c) + SPAN.M15 > start && candleTime(c) + SPAN.M15 <= at
    );
    const path = replayPath(levels, sinceStart);
    frame.progress = {
      state: path.state,
      stage: lifecycleStage(path),
      touchedAt: path.touchedAt,
      filledAt: path.filledAt,
      fillPrice: path.fillPrice,
      pips: path.pips,
      tpHits: path.tpHits,
    };
    if (options.reveal) {
      const viewCache = new Map<string, TimeframeView | null>();
      const viewAt = (tf: Timeframe, t: number) => {
        const key = `${tf}:${lastClosedIndex(history[tf] ?? [], tf, t)}`;
        if (!viewCache.has(key)) {
          const c = closedBy(history[tf] ?? [], tf, t, BARS[tf] ?? 200);
          viewCache.set(key, c.length >= 5 ? analyzeTimeframe(pair, tf, c) : null);
        }
        return viewCache.get(key) ?? null;
      };
      const result = simulateTrade(pair, levels, start, window.end.getTime(), history, viewAt);
      frame.outcome = {
        status: result.status,
        pips: result.pips,
        closedAt: result.closedAt,
        note: result.note,
      };
    }
  }
  return frame;
}

/**
 * The cached Twelve Data history files for a pair that cover `at` (the
 * backtest downloads them), newest download first. Null when none do.
 */
export async function cachedHistoryAt(pair: PairCode, at: number): Promise<HistorySet | null> {
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(HISTORY_DIR).catch(() => [] as string[]);
  const prefix = pair.replace('/', '');
  const history: HistorySet = {};
  for (const tf of INTRADAY_TIMEFRAMES) {
    const re = new RegExp(`^${prefix}-${tf}-(\\d{4}-\\d{2}-\\d{2})-(\\d{4}-\\d{2}-\\d{2})\\.json$`);
    const match = files
      .map((f) => ({ f, m: f.match(re) }))
      .filter((x) => x.m && Date.parse(x.m[1]) <= at && Date.parse(x.m[2]) + 86_400_000 >= at)
      .sort((a, b) => Date.parse(b.m![2]) - Date.parse(a.m![2]) || Date.parse(a.m![1]) - Date.parse(b.m![1]))[0];
    if (!match) return null;
    history[tf] = await readCachedFile(match.f);
  }
  return history;
}

/** Parsed history files kept in memory while stepping through a replay. */
const parsedFiles = new Map<string, Candle[]>();
async function readCachedFile(name: string): Promise<Candle[]> {
  const hit = parsedFiles.get(name);
  if (hit) return hit;
  const candles = JSON.parse(await readFile(resolve(HISTORY_DIR, name), 'utf8')) as Candle[];
  if (parsedFiles.size >= 8) parsedFiles.delete(parsedFiles.keys().next().value!);
  parsedFiles.set(name, candles);
  return candles;
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
  /** Calls not taken because of the USD cap or the daily loss limit. */
  portfolioBlocked: number;
  /** Average round-trip cost deducted per filled trade, by pair (pips). */
  costPips: Record<string, number>;
  /** Why calls stood aside or published trades never filled, by reason. */
  reasons: Partial<Record<ReasonCode, number>>;
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
  /** Resampled / reshuffled trade results: how much of the result is luck. */
  monteCarlo: MonteCarlo | null;
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
  extra: {
    standAsides: number;
    skippedOpen: number;
    portfolioBlocked?: number;
    standAsideReasons?: Partial<Record<ReasonCode, number>>;
  }
): BacktestSummary {
  const reasons: Partial<Record<ReasonCode, number>> = {
    ...(extra.standAsideReasons ?? {}),
  };
  for (const t of all)
    if (t.reasonCode) reasons[t.reasonCode] = (reasons[t.reasonCode] ?? 0) + 1;
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
    portfolioBlocked: extra.portfolioBlocked ?? 0,
    reasons,
    // Average per filled trade (fixed, or the real spread at each fill).
    costPips: Object.fromEntries(
      [...new Set(closed.map((t) => t.pairCode))].map((p) => {
        const costs = closed.filter((t) => t.pairCode === p).map((t) => t.costPips);
        return [p, Number((costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(2))];
      })
    ),
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
    monteCarlo: monteCarlo(closed.map((t) => t.r ?? 0)),
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
      const histories = await loadHistories(from, to);
      // The live engine: level model, filters and scan mode.
      const result = simulatePortfolio(
        histories,
        events,
        from,
        to,
        { ...liveLevelModel(), filters: liveFilters() },
        { scans: liveScanMode() }
      );
      const trades = result.trades.sort((a, b) =>
        a.publishedAt.localeCompare(b.publishedAt)
      );
      const summary = summarize(trades, from, to, result);
      await prisma.backtestRun.update({
        where: { id: run.id },
        data: {
          status: 'DONE',
          finishedAt: new Date(),
          summary: summary as unknown as Prisma.InputJsonValue,
          trades: trades as unknown as Prisma.InputJsonValue,
          strategy: liveStrategy() as unknown as Prisma.InputJsonValue,
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
