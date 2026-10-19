import { describe, expect, it } from 'vitest';
import { excursion, exitResult, type ExitPath } from '../src/lib/exits.js';
import type { Candle } from '../src/lib/technical.js';

/** Long from 1.1000 with the stop at 1.0980 (1R = 20 pips). */
function path(rows: [number, number, number][]): ExitPath {
  let t = Date.parse('2026-10-06T08:00:00Z');
  const candles: Candle[] = rows.map(([low, high, close]) => {
    const datetime = new Date(t).toISOString().slice(0, 19).replace('T', ' ');
    t += 15 * 60_000;
    return { datetime, open: close, high, low, close };
  });
  return { direction: 'LONG', fill: 1.1, stop: 1.098, candles, windowEnd: Date.parse('2026-10-06T12:00:00Z') };
}

describe('exit research', () => {
  it('measures MFE and MAE until the stop', () => {
    const e = excursion(path([[1.099, 1.103, 1.102], [1.0975, 1.101, 1.098]]))!;
    expect(e.stopped).toBe(true);
    expect(e.mfeR).toBeCloseTo(1.5, 6);
    expect(e.maeR).toBe(1);
  });

  it('fixed target, break-even and thirds on the same path', () => {
    // Up to +1.5R, back below entry, then to the stop.
    const p = path([[1.0995, 1.103, 1.1025], [1.0995, 1.1005, 1.1], [1.0975, 1.1, 1.098]]);
    expect(exitResult(p, { kind: 'fixed', targetR: 1 })).toBe(1);
    expect(exitResult(p, { kind: 'fixed', targetR: 2 })).toBe(-1);
    // Stop moved to entry after +1R: scratch.
    expect(exitResult(p, { kind: 'breakeven', targetR: 2, afterR: 1 })).toBeCloseTo(0, 6);
    // A third at +1R, the rest back at entry.
    expect(exitResult(p, { kind: 'thirds' })).toBeCloseTo(1 / 3, 6);
  });

  it('time exits close at the open of the first candle past the deadline', () => {
    const p = { ...path([[1.0995, 1.101, 1.1005], [1.1, 1.102, 1.1015]]), windowEnd: Date.parse('2026-10-06T08:15:00Z') };
    expect(exitResult(p, { kind: 'windowEnd', targetR: 2 })).toBeCloseTo(0.75, 6);
  });
});
