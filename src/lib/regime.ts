import { atr, type Candle, type TimeframeView } from './technical.js';

// ---- Market regime labels ------------------------------------------------------
//
// Labels only: recorded on every signal so results can be grouped by market
// conditions. They do not change what the engine trades; a label earns a
// rule only if it separates results out of sample.

export type Trend = 'TRENDING' | 'RANGING' | 'MIXED';
export type Volatility = 'HIGH' | 'NORMAL' | 'LOW';

export interface SignalFeatures {
  trend: Trend;
  volatility: Volatility;
  /** Net move ÷ path length over the last 20 H1 bars (0 = pure chop, 1 = straight line). */
  efficiency: number | null;
  choppy: boolean;
  /** H1 ATR ÷ its median over the last 100 bars. */
  atrRatio: number | null;
  /** A high-impact release for either currency falls inside the window. */
  newsInWindow: boolean;
  /** Daily and H4 agree on the bias. */
  contextAligned: boolean;
  /** Live spread at publish (pips), when an MT5 terminal reported one. */
  spreadPips?: number | null;
  /** Same pair + direction + structure = the same setup (duplicate guard). */
  setupKey?: string | null;
}

/** Efficiency ratio of closes over `bars` (oldest first input). */
export function efficiencyRatio(closes: number[], bars = 20): number | null {
  if (closes.length < bars + 1) return null;
  const slice = closes.slice(-(bars + 1));
  const net = Math.abs(slice[slice.length - 1] - slice[0]);
  let path = 0;
  for (let i = 1; i < slice.length; i += 1) path += Math.abs(slice[i] - slice[i - 1]);
  return path === 0 ? 0 : Number((net / path).toFixed(3));
}

/**
 * H1 ATR now relative to its median over the last `lookback` closed bars.
 * One pass: ATR(14) at each bar is the mean of its last 14 true ranges
 * (the same definition as technical.atr).
 */
export function atrRatio(h1OldestFirst: Candle[], lookback = 100): number | null {
  const n = h1OldestFirst.length;
  if (n < lookback + 15) return null;
  const tr: number[] = [];
  for (let i = 1; i < n; i += 1) {
    const c = h1OldestFirst[i];
    const pc = h1OldestFirst[i - 1].close;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
  }
  // atrAt[k]: ATR of the candles [0, k] — mean of tr[k-14 .. k-1].
  const atrAt = (k: number) => {
    let sum = 0;
    for (let j = k - 14; j < k; j += 1) sum += tr[j];
    return sum / 14;
  };
  const now = atrAt(tr.length);
  const past: number[] = [];
  for (let end = n - lookback; end < n; end += 1) past.push(atrAt(end - 1));
  past.sort((x, y) => x - y);
  const median = past[Math.floor(past.length / 2)];
  return median > 0 ? Number((now / median).toFixed(2)) : null;
}

export function signalFeatures(input: {
  /** Daily + H4 weighted context score (−100…100). */
  contextScore: number;
  daily?: TimeframeView;
  h4?: TimeframeView;
  /** Newest first, as fetched. */
  h1Candles: Candle[];
  newsInWindow: boolean;
}): SignalFeatures {
  const h1 = [...input.h1Candles].reverse();
  const efficiency = efficiencyRatio(h1.map((c) => c.close));
  const ratio = atrRatio(h1);
  const contextAligned = Boolean(
    input.daily && input.h4 && input.daily.bias === input.h4.bias && input.daily.bias !== 'NEUTRAL'
  );
  const strength = Math.abs(input.contextScore);
  return {
    trend: strength >= 40 && contextAligned ? 'TRENDING' : strength < 15 ? 'RANGING' : 'MIXED',
    volatility: ratio === null ? 'NORMAL' : ratio >= 1.5 ? 'HIGH' : ratio <= 0.7 ? 'LOW' : 'NORMAL',
    efficiency,
    choppy: efficiency !== null && efficiency < 0.2,
    atrRatio: ratio,
    newsInWindow: input.newsInWindow,
    contextAligned,
  };
}
