import type { Direction, PairCode } from './model.js';
import type { LiveMarketEvent } from './liveData.js';

// ---- Risk controls shared by the live engine and the backtest -----------------
//
// These do not pick trades from past results (nothing here is fitted); they
// limit what a trade may cost: execution costs, entries into news, stacking
// the same USD bet on both pairs, and a bad day.

/** Typical retail spread plus slippage, round trip, in pips. */
const SPREAD_AND_SLIPPAGE_PIPS: Record<PairCode, number> = {
  'EUR/USD': 1.2,
  'USD/JPY': 1.5,
};

/**
 * Commission per round trip, in pips. 0 by default: standard accounts charge
 * through the spread above. For a raw-spread account set COMMISSION_PIPS
 * (e.g. $7 per lot round turn on EUR/USD ≈ 0.7 pips).
 */
export const COMMISSION_PIPS = Math.max(0, Number(process.env.COMMISSION_PIPS ?? 0) || 0);

/**
 * Round-trip execution cost per trade, in pips: spread + slippage +
 * commission. Deducted from every filled backtest trade, and built into the
 * target so 2R is 2R after costs.
 */
export const EXECUTION_COST_PIPS: Record<PairCode, number> = {
  'EUR/USD': Number((SPREAD_AND_SLIPPAGE_PIPS['EUR/USD'] + COMMISSION_PIPS).toFixed(2)),
  'USD/JPY': Number((SPREAD_AND_SLIPPAGE_PIPS['USD/JPY'] + COMMISSION_PIPS).toFixed(2)),
};

/** Slippage added on top of a real (bid/ask history) spread. */
export const SLIPPAGE_PIPS = 0.2;

/** No entries from this long before a high-impact release until this long after it. */
export const NEWS_BLACKOUT_BEFORE_MS = 30 * 60_000;
export const NEWS_BLACKOUT_AFTER_MS = 30 * 60_000;

/** No new trades for the rest of the UTC day once the day's closed trades lost this much. */
export const DAILY_LOSS_LIMIT_R = 2;

export interface Blackout {
  /** ms since epoch */
  from: number;
  to: number;
  /** e.g. "USD Non-Farm Payrolls" */
  title: string;
}

/** High-impact releases for the pair's two currencies that overlap [from, to]. */
export function newsBlackouts(
  events: LiveMarketEvent[],
  pair: PairCode,
  from: number,
  to: number
): Blackout[] {
  const currencies = pair.split('/');
  return events
    .filter(
      (e) => e.impact === 'HIGH' && currencies.includes(e.currency.toUpperCase())
    )
    .map((e) => ({
      from: e.eventDate.getTime() - NEWS_BLACKOUT_BEFORE_MS,
      to: e.eventDate.getTime() + NEWS_BLACKOUT_AFTER_MS,
      title: `${e.currency} ${e.title}`,
    }))
    .filter((b) => b.to > from && b.from < to)
    .sort((a, b) => a.from - b.from);
}

/** Blackouts stored on a signal, read back defensively from JSON. */
export function blackoutsFromJson(value: unknown): Blackout[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (b): b is Blackout =>
      typeof b === 'object' &&
      b !== null &&
      typeof (b as Blackout).from === 'number' &&
      typeof (b as Blackout).to === 'number'
  );
}

/** +1 when the trade is long USD, −1 when short USD, 0 for a stand-aside. */
export function usdSide(pair: PairCode, direction: Direction): number {
  if (direction === 'NEUTRAL') return 0;
  const long = direction === 'LONG' ? 1 : -1;
  const [base] = pair.split('/');
  return base === 'USD' ? long : -long;
}

export interface Exposure {
  pairCode: PairCode;
  direction: Direction;
}

/**
 * Portfolio check for a new trade, given the trades already open or waiting
 * for entry and the R already lost today:
 * - EUR/USD and USD/JPY are both USD trades; a second trade on the same USD
 *   side would be one double-sized bet, so it is not taken (an opposite USD
 *   side is a hedge and is allowed);
 * - after DAILY_LOSS_LIMIT_R of closed losses in a UTC day, nothing new.
 * Returns why to stand aside, or null.
 */
export function portfolioBlock(
  candidate: Exposure,
  active: Exposure[],
  realizedRToday: number
): { code: 'DAILY_LOSS_LIMIT' | 'USD_EXPOSURE'; reason: string } | null {
  if (candidate.direction === 'NEUTRAL') return null;
  if (realizedRToday <= -DAILY_LOSS_LIMIT_R)
    return {
      code: 'DAILY_LOSS_LIMIT',
      reason: `Daily loss limit reached (${realizedRToday.toFixed(1)}R today) — no new trades until tomorrow.`,
    };
  const side = usdSide(candidate.pairCode, candidate.direction);
  const clash = active.find(
    (a) =>
      a.pairCode !== candidate.pairCode &&
      usdSide(a.pairCode, a.direction) === side
  );
  if (clash)
    return {
      code: 'USD_EXPOSURE',
      reason: `${clash.pairCode} ${clash.direction.toLowerCase()} is already ${side > 0 ? 'long' : 'short'} USD — a second ${side > 0 ? 'long' : 'short'}-USD trade would double the same bet.`,
    };
  return null;
}

// ---- Monte Carlo over a trade list --------------------------------------------

export interface MonteCarlo {
  runs: number;
  /** Bootstrap (trades resampled with replacement): spread of the net result. */
  netR: { p5: number; p50: number; p95: number };
  /** Share of bootstrap runs that ended positive. */
  probProfit: number;
  /** Trade order shuffled: spread of the worst drawdown and losing streak. */
  maxDrawdownR: { p50: number; p95: number };
  longestLosingStreak: { p50: number; p95: number };
}

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

/** Deterministic (seeded) so the same trades always give the same report. */
export function monteCarlo(rs: number[], runs = 2000, seed = 7): MonteCarlo | null {
  if (rs.length < 2) return null;
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const nets: number[] = [];
  const dds: number[] = [];
  const streaks: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    let net = 0;
    for (let i = 0; i < rs.length; i += 1) net += rs[Math.floor(rnd() * rs.length)];
    nets.push(net);

    const order = [...rs];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let equity = 0;
    let peak = 0;
    let dd = 0;
    let streak = 0;
    let longest = 0;
    for (const r of order) {
      equity += r;
      peak = Math.max(peak, equity);
      dd = Math.max(dd, peak - equity);
      streak = r < 0 ? streak + 1 : 0;
      longest = Math.max(longest, streak);
    }
    dds.push(dd);
    streaks.push(longest);
  }
  const sort = (a: number[]) => [...a].sort((x, y) => x - y);
  const n = sort(nets);
  const d = sort(dds);
  const k = sort(streaks);
  const r2 = (x: number) => Number(x.toFixed(2));
  return {
    runs,
    netR: { p5: r2(percentile(n, 0.05)), p50: r2(percentile(n, 0.5)), p95: r2(percentile(n, 0.95)) },
    probProfit: r2(nets.filter((x) => x > 0).length / runs),
    maxDrawdownR: { p50: r2(percentile(d, 0.5)), p95: r2(percentile(d, 0.95)) },
    longestLosingStreak: { p50: percentile(k, 0.5), p95: percentile(k, 0.95) },
  };
}
