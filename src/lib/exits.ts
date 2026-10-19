import type { Candle } from './technical.js';

// ---- Exit research (backtest only) ------------------------------------------------
//
// Given a trade's real fill, its stop and the candles after the fill, measure
// how far it went for (MFE) and against (MAE) it, and how alternative exit
// rules would have closed it. Nothing here is used live: an exit rule is only
// switched on after it is positive out of sample (spec, section 8).

export interface ExitPath {
  direction: 'LONG' | 'SHORT';
  fill: number;
  stop: number;
  /** Candles after the fill, oldest first, up to the hold limit. */
  candles: Candle[];
  /** ms: when the trade's window ends (for the time exit). */
  windowEnd: number;
}

/** Excursions in R (R = distance from the fill to the stop). */
export interface Excursion {
  /** Best move for the trade before the stop traded (or the hold limit). */
  mfeR: number;
  /** Worst move against it before that point (1 when the stop traded). */
  maeR: number;
  stopped: boolean;
}

function candleMs(c: Candle) {
  const iso = c.datetime.includes(' ')
    ? `${c.datetime.replace(' ', 'T')}Z`
    : `${c.datetime}T00:00:00Z`;
  return Date.parse(iso);
}

export function excursion(path: ExitPath): Excursion | null {
  const long = path.direction === 'LONG';
  const risk = Math.abs(path.fill - path.stop);
  if (!(risk > 0)) return null;
  let mfe = 0;
  let mae = 0;
  for (const c of path.candles) {
    const adverse = long ? path.fill - c.low : c.high - path.fill;
    const favorable = long ? c.high - path.fill : path.fill - c.low;
    // A stop and a new high inside one candle: assume the stop came first.
    if (adverse >= risk) return { mfeR: mfe / risk, maeR: 1, stopped: true };
    mfe = Math.max(mfe, favorable);
    mae = Math.max(mae, adverse);
  }
  return { mfeR: mfe / risk, maeR: mae / risk, stopped: false };
}

export type ExitRule =
  | { kind: 'fixed'; targetR: number }
  | { kind: 'breakeven'; targetR: number; afterR: number }
  | { kind: 'thirds' }
  | { kind: 'windowEnd'; targetR: number }
  | { kind: 'hours'; targetR: number; hours: number };

/**
 * The result in R (before costs) of one exit rule on one path. Within a
 * candle the stop is assumed to trade before a target; a moved stop applies
 * from the next candle. Anything still open at the end of the path closes at
 * the last close.
 */
export function exitResult(path: ExitPath, rule: ExitRule): number | null {
  const long = path.direction === 'LONG';
  const risk = Math.abs(path.fill - path.stop);
  if (!(risk > 0) || path.candles.length === 0) return null;
  const at = (r: number) => path.fill + (long ? 1 : -1) * r * risk;
  const reached = (c: Candle, level: number) => (long ? c.high >= level : c.low <= level);
  const through = (c: Candle, level: number) => (long ? c.low <= level : c.high >= level);
  const rOf = (price: number) => ((long ? price - path.fill : path.fill - price) / risk);
  const deadline =
    rule.kind === 'windowEnd'
      ? path.windowEnd
      : rule.kind === 'hours'
        ? candleMs(path.candles[0]) + rule.hours * 3_600_000
        : Infinity;

  if (rule.kind === 'thirds') {
    // A third at 1R, 2R, 3R; stop to entry after TP1, to TP1 after TP2.
    let stop = path.stop;
    let next: number | null = null;
    let hits = 0;
    let booked = 0;
    for (const c of path.candles) {
      if (next !== null) {
        stop = next;
        next = null;
      }
      if (through(c, stop)) return booked + ((3 - hits) / 3) * rOf(stop);
      while (hits < 3 && reached(c, at(hits + 1))) {
        hits += 1;
        booked += (hits) / 3;
        if (hits < 3) next = hits === 1 ? path.fill : at(1);
      }
      if (hits === 3) return booked;
    }
    const last = path.candles[path.candles.length - 1].close;
    return booked + ((3 - hits) / 3) * rOf(last);
  }

  const target = at(rule.targetR);
  let stop = path.stop;
  let next: number | null = null;
  for (const c of path.candles) {
    if (candleMs(c) >= deadline) return rOf(c.open);
    if (next !== null) {
      stop = next;
      next = null;
    }
    if (through(c, stop)) return rOf(stop);
    if (reached(c, target)) return rule.targetR;
    if (rule.kind === 'breakeven' && stop === path.stop && reached(c, at(rule.afterR)))
      next = path.fill;
  }
  return rOf(path.candles[path.candles.length - 1].close);
}
