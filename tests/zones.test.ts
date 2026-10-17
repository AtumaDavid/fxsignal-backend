import { describe, expect, it } from 'vitest';
import { replayPath, settleFromCandles } from '../src/lib/predictions.js';
import {
  displacementZones,
  mergeZones,
  pivots,
  planZoneTrade,
  type ZoneSource,
} from '../src/lib/zones.js';
import type { Candle } from '../src/lib/technical.js';
import { LONG_LEVELS } from './helpers.js';

/** Consecutive candles from [open, high, low, close] tuples. */
function bars(startIso: string, spanMin: number, rows: [number, number, number, number][]): Candle[] {
  let t = Date.parse(startIso);
  return rows.map(([open, high, low, close]) => {
    const datetime = new Date(t).toISOString().slice(0, 19).replace('T', ' ');
    t += spanMin * 60_000;
    return { datetime, open, high, low, close };
  });
}

const CONFIRMED = { ...LONG_LEVELS, entryTrigger: 'M15_CLOSE' as const };
const START = '2026-10-06T08:00:00Z';

describe('M15-close entry trigger', () => {
  it('a touch alone is not a fill', () => {
    // Trades into 1.1000–1.1010 but closes bearish both times.
    const candles = bars(START, 15, [
      [1.1012, 1.1014, 1.1004, 1.1006],
      [1.1006, 1.1009, 1.1001, 1.1003],
    ]);
    const path = replayPath(CONFIRMED, candles);
    expect(path.state).toBe('waiting');
    expect(settleFromCandles(CONFIRMED, candles).note).toMatch(/No confirmed entry/);
    // The same candles fill a TOUCH signal.
    expect(replayPath(LONG_LEVELS, candles).state).toBe('running');
  });

  it('fills at the close of the first bullish candle after the touch', () => {
    const candles = bars(START, 15, [
      [1.1012, 1.1014, 1.1004, 1.1006], // touch, bearish
      [1.1005, 1.1009, 1.1002, 1.1008], // bullish close inside the zone: fill 1.1008
      [1.1008, 1.1009, 1.098, 1.0982], // stop
    ]);
    const path = replayPath(CONFIRMED, candles);
    expect(path.fillPrice).toBeCloseTo(1.1008, 6);
    expect(path.filledAt).toBe(Date.parse('2026-10-06T08:15:00Z'));
    expect(path.state).toBe('stopped');
    // Measured from the real fill: 1.1008 → 1.0985 is −23 pips (the midpoint would say −20).
    expect(path.pips).toBe(-23);
  });

  it('does not judge stop or target on the confirming candle itself', () => {
    // Confirming candle wicks to the stop before closing up; then TP1 trades.
    const candles = bars(START, 15, [
      [1.1006, 1.1009, 1.1001, 1.1008],
      [1.1008, 1.1026, 1.1007, 1.102],
    ]);
    const path = replayPath(CONFIRMED, candles);
    expect(path.state).toBe('running');
    expect(path.tpHits).toBe(1);
  });

  it('no entry when the stop trades before a confirmation', () => {
    const candles = bars(START, 15, [
      [1.1006, 1.1008, 1.0982, 1.0984], // through the stop
      [1.0984, 1.1009, 1.0983, 1.1007], // bullish close in the zone — too late
    ]);
    expect(replayPath(CONFIRMED, candles).state).toBe('waiting');
  });

  it('a close that ran beyond half the zone width is a chase, not a fill', () => {
    const candles = bars(START, 15, [
      [1.1004, 1.1022, 1.1003, 1.102], // bullish, closes 1.1020 > 1.1010 + 0.0005
    ]);
    expect(replayPath(CONFIRMED, candles).state).toBe('waiting');
  });
});

describe('zone detection', () => {
  it('finds confirmed fractal pivots only', () => {
    const lows = [5, 4, 3, 2, 3, 4, 5, 4, 3];
    const candles = bars(START, 60, lows.map((l) => [l + 0.5, l + 1, l, l + 0.5]));
    const { lows: found, highs } = pivots(candles, 2);
    expect(found.map((p) => p.index)).toEqual([3]);
    // The last bars cannot be confirmed yet.
    expect(highs.every((p) => p.index <= candles.length - 3)).toBe(true);
  });

  it('marks a small base followed by a strong rally as demand, and drops it once closed through', () => {
    const flat: [number, number, number, number][] = Array.from({ length: 20 }, (_, i) => {
      const o = 1.1 + (i % 2 ? 0.0004 : -0.0004);
      return [o, o + 0.0006, o - 0.0006, o + (i % 2 ? -0.0003 : 0.0003)];
    });
    const base: [number, number, number, number] = [1.1, 1.1004, 1.0996, 1.1001];
    const rally: [number, number, number, number][] = [
      [1.1001, 1.1025, 1.1, 1.1024],
      [1.1024, 1.105, 1.1022, 1.1048],
    ];
    const candles = bars(START, 240, [...flat, base, ...rally, [1.1048, 1.1052, 1.104, 1.1045]]);
    const demand = displacementZones('H4', candles, false).find(
      (z) => z.kind === 'DEMAND' && Math.abs(z.low - 1.0996) < 1e-9
    );
    expect(demand).toBeDefined();
    expect(demand!.high).toBeCloseTo(1.1001, 6); // body top
    expect(demand!.fresh).toBe(true);

    // A close below every base breaks them all.
    const broken = bars(START, 240, [...flat, base, ...rally, [1.1045, 1.1046, 1.098, 1.0985]]);
    expect(displacementZones('H4', broken, false).some((z) => z.kind === 'DEMAND')).toBe(false);
  });

  it('merges overlapping sources into one zone, scored once', () => {
    const sources: ZoneSource[] = [
      { timeframe: 'DAILY', kind: 'PIVOT_LOW', low: 1.1, high: 1.1008 },
      { timeframe: 'H4', kind: 'DEMAND', low: 1.1004, high: 1.1012, fresh: true },
      { timeframe: 'H4', kind: 'PIVOT_HIGH', low: 1.105, high: 1.1056 },
    ];
    const zones = mergeZones(sources, 1.103, 0.003);
    expect(zones).toHaveLength(2);
    const [support, resistance] = zones;
    expect(support.label).toBe('Daily support + H4 demand');
    // Daily 3 + one more timeframe 0.5 + fresh 0.5 — not 3 + 2 + …
    expect(support.score).toBe(4);
    expect(support.low).toBeCloseTo(1.1, 6);
    expect(support.high).toBeCloseTo(1.1012, 6);
    expect(resistance.label).toBe('H4 resistance');
  });
});

describe('zone trade plan', () => {
  const support: ZoneSource = { timeframe: 'DAILY', kind: 'PIVOT_LOW', low: 1.1, high: 1.101 };
  const opts = { reach: 0.002, minR: 2, maxRiskPips: 60 };

  it('enters at the zone, stops beyond it, and targets 2R when there is room', () => {
    const map = { price: 1.1018, zones: mergeZones([support], 1.1018, 0.003) };
    const res = planZoneTrade('EUR/USD', 'LONG', map, opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.entryLow).toBeCloseTo(1.1, 6);
    expect(res.plan.entryHigh).toBeCloseTo(1.101, 6);
    expect(res.plan.invalidationPrice).toBeCloseTo(1.0988, 6); // 12p below the zone's near edge
    expect(res.plan.targetPrice).toBeCloseTo(1.1039, 6); // mid 1.1005 + 2 × 17p
  });

  it('rejects the trade when resistance sits before the 2R target', () => {
    const blocker: ZoneSource = { timeframe: 'H4', kind: 'PIVOT_HIGH', low: 1.1025, high: 1.103 };
    const map = { price: 1.1018, zones: mergeZones([support, blocker], 1.1018, 0.003) };
    const res = planZoneTrade('EUR/USD', 'LONG', map, opts);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/H4 resistance sits 20 pips/);
  });

  it('needs a higher-timeframe zone: an H1 order block alone is not a location', () => {
    const ob: ZoneSource = { timeframe: 'H1', kind: 'BULLISH_OB', low: 1.1, high: 1.101 };
    const map = { price: 1.1018, zones: mergeZones([ob], 1.1018, 0.003) };
    expect(planZoneTrade('EUR/USD', 'LONG', map, opts).ok).toBe(false);
  });

  it('uses an H1 order block inside the zone as the entry', () => {
    const wide: ZoneSource = { timeframe: 'H4', kind: 'DEMAND', low: 1.0995, high: 1.1015 };
    const ob: ZoneSource = { timeframe: 'H1', kind: 'BULLISH_OB', low: 1.0998, high: 1.1004 };
    const map = { price: 1.102, zones: mergeZones([wide, ob], 1.102, 0.003) };
    const res = planZoneTrade('EUR/USD', 'LONG', map, opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.orderBlock).not.toBeNull();
    // OB 1.0998–1.1004 padded to the 8-pip minimum around its middle.
    expect(res.plan.entryLow).toBeCloseTo(1.0997, 6);
    expect(res.plan.entryHigh).toBeCloseTo(1.1005, 6);
  });
});
