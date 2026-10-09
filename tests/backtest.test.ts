import { describe, expect, it } from 'vitest';
import { simulatePair, summarize, type HistorySet } from '../src/lib/backtest.js';
import type { Candle } from '../src/lib/technical.js';

/** Deterministic synthetic history: a slow wave plus seeded noise, at M15. */
function synthetic(fromIso: string, toIso: string): HistorySet {
  let px = 1.1;
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const m15: (Candle & { t: number })[] = [];
  for (let t = Date.parse(fromIso); t < Date.parse(toIso); t += 15 * 60_000) {
    const d = new Date(t);
    const day = d.getUTCDay();
    if (day === 6 || (day === 0 && d.getUTCHours() < 22) || (day === 5 && d.getUTCHours() >= 22)) continue;
    const o = px;
    px += Math.sin(t / (86_400_000 * 8)) * 0.00004 + (rnd() - 0.5) * 0.0008;
    m15.push({
      t,
      datetime: d.toISOString().slice(0, 19).replace('T', ' '),
      open: o,
      high: Math.max(o, px) + rnd() * 0.0003,
      low: Math.min(o, px) - rnd() * 0.0003,
      close: px,
    });
  }
  const agg = (span: number, daily = false) => {
    const out: Candle[] = [];
    let cur: (Candle & { b: number }) | null = null;
    for (const c of m15) {
      const b = Math.floor(c.t / span) * span;
      if (!cur || cur.b !== b) {
        if (cur) out.push(cur);
        const iso = new Date(b).toISOString();
        cur = { b, datetime: daily ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' '), open: c.open, high: c.high, low: c.low, close: c.close };
      } else {
        cur.high = Math.max(cur.high, c.high);
        cur.low = Math.min(cur.low, c.low);
        cur.close = c.close;
      }
    }
    if (cur) out.push(cur);
    return out;
  };
  return {
    M15: m15.map(({ t: _t, ...c }) => c),
    H1: agg(3_600_000),
    H4: agg(4 * 3_600_000),
    DAILY: agg(86_400_000, true),
  };
}

describe('backtest', () => {
  const history = synthetic('2025-10-01T00:00:00Z', '2026-07-01T00:00:00Z');
  const from = new Date('2026-04-01T00:00:00Z');
  const to = new Date('2026-07-01T00:00:00Z');
  const run = simulatePair('EUR/USD', history, [], from, to);
  const summary = summarize(run.trades, from, to, run);

  it('produces trades inside the range, one per window at most', () => {
    expect(run.trades.length).toBeGreaterThan(5);
    const keys = new Set(run.trades.map((t) => t.publishedAt));
    expect(keys.size).toBe(run.trades.length);
    for (const t of run.trades) {
      expect(Date.parse(t.publishedAt)).toBeGreaterThanOrEqual(from.getTime());
      expect(Date.parse(t.publishedAt)).toBeLessThan(to.getTime());
    }
  });

  it('scores every trade consistently (R = pips ÷ stop)', () => {
    for (const t of run.trades) {
      if (t.pips === null || t.r === null) continue;
      expect(t.r).toBeCloseTo(t.pips / t.stopPips, 1);
      if (t.status === 'MISSED') expect(t.r).toBeCloseTo(-1, 1);
      if (t.status === 'HIT') expect(t.r).toBeGreaterThan(0);
    }
  });

  it('never opens a new trade on the pair while one is open', () => {
    const filled = run.trades.filter((t) => t.filled && t.closedAt);
    for (let i = 1; i < filled.length; i += 1)
      expect(Date.parse(filled[i].publishedAt)).toBeGreaterThanOrEqual(
        Date.parse(filled[i - 1].closedAt!)
      );
  });

  it('summarises with a curve that ends at the net result', () => {
    expect(summary.curve.at(-1)?.r).toBeCloseTo(summary.netR, 1);
    expect(summary.maxDrawdownR).toBeGreaterThanOrEqual(0);
    expect(summary.wins + summary.losses + summary.earlyExits + summary.timeExits).toBe(summary.trades);
  });
});
