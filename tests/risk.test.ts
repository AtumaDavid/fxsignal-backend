import { describe, expect, it } from 'vitest';
import { replayPath } from '../src/lib/predictions.js';
import {
  DAILY_LOSS_LIMIT_R,
  monteCarlo,
  newsBlackouts,
  portfolioBlock,
  usdSide,
} from '../src/lib/risk.js';
import { costAllowance, mergeZones, planZoneTrade, roomCheck } from '../src/lib/zones.js';
import type { Candle } from '../src/lib/technical.js';
import type { LiveMarketEvent } from '../src/lib/liveData.js';
import { LONG_LEVELS } from './helpers.js';

function bars(startIso: string, rows: [number, number, number, number][]): Candle[] {
  let t = Date.parse(startIso);
  return rows.map(([open, high, low, close]) => {
    const datetime = new Date(t).toISOString().slice(0, 19).replace('T', ' ');
    t += 15 * 60_000;
    return { datetime, open, high, low, close };
  });
}
const CONFIRMED = { ...LONG_LEVELS, entryTrigger: 'M15_CLOSE' as const };
const START = '2026-10-06T12:00:00Z';
const TOUCH: [number, number, number, number] = [1.1012, 1.1014, 1.1004, 1.1006];
const AWAY: [number, number, number, number] = [1.1013, 1.1018, 1.1012, 1.1016];
const CONFIRM: [number, number, number, number] = [1.1005, 1.1015, 1.1004, 1.1013];

describe('stale and late confirmations', () => {
  it('expires a touch after CONFIRM_WINDOW_BARS candles away from the zone', () => {
    // Touch, five candles away, then a bullish close just above the zone (not in it).
    const stale = bars(START, [TOUCH, AWAY, AWAY, AWAY, AWAY, AWAY, [1.1012, 1.1016, 1.1011, 1.1014]]);
    expect(replayPath(CONFIRMED, stale).state).toBe('waiting');
    const fresh = bars(START, [TOUCH, AWAY, AWAY, [1.1012, 1.1016, 1.1011, 1.1014]]);
    expect(replayPath(CONFIRMED, fresh).state).toBe('running');
  });

  it('does not chase once TP1 traded before an entry', () => {
    const candles = bars(START, [TOUCH, [1.1006, 1.1027, 1.1006, 1.1024], CONFIRM]);
    expect(replayPath(CONFIRMED, candles).state).toBe('waiting');
  });
});

describe('news blackout', () => {
  const event = (impact: 'HIGH' | 'MEDIUM', currency: string, at: string): LiveMarketEvent => ({
    externalId: at + currency,
    currency,
    title: 'Non-Farm Payrolls',
    eventDate: new Date(at),
    impact,
    forecast: null,
    previousValue: null,
  });

  it('only high-impact releases for the pair’s currencies, ±30 minutes', () => {
    const events = [
      event('HIGH', 'USD', '2026-10-06T12:30:00Z'),
      event('MEDIUM', 'USD', '2026-10-06T13:00:00Z'),
      event('HIGH', 'GBP', '2026-10-06T13:00:00Z'),
    ];
    const from = Date.parse('2026-10-06T12:00:00Z');
    const b = newsBlackouts(events, 'EUR/USD', from, from + 5 * 3_600_000);
    expect(b).toHaveLength(1);
    expect(b[0].from).toBe(Date.parse('2026-10-06T12:00:00Z'));
    expect(b[0].to).toBe(Date.parse('2026-10-06T13:00:00Z'));
  });

  it('no fill inside the blackout; a confirmation after it fills', () => {
    const blackouts = [{ from: Date.parse('2026-10-06T12:00:00Z'), to: Date.parse('2026-10-06T12:30:00Z'), title: 'USD NFP' }];
    const row = { ...CONFIRMED, blackouts };
    // 12:00 touch+confirm (blocked), 12:15 confirm (blocked), 12:30 confirm (fills).
    const path = replayPath(row, bars(START, [CONFIRM, CONFIRM, CONFIRM]));
    expect(path.state).toBe('running');
    expect(path.filledAt).toBe(Date.parse('2026-10-06T12:30:00Z'));
    expect(replayPath(CONFIRMED, bars(START, [CONFIRM])).filledAt).toBe(Date.parse(START));
  });
});

describe('portfolio rules', () => {
  it('knows which side of USD a trade is on', () => {
    expect(usdSide('EUR/USD', 'LONG')).toBe(-1);
    expect(usdSide('USD/JPY', 'LONG')).toBe(1);
    expect(usdSide('USD/JPY', 'NEUTRAL')).toBe(0);
  });

  it('blocks a second trade on the same USD side, allows a hedge', () => {
    const open = [{ pairCode: 'EUR/USD' as const, direction: 'LONG' as const }]; // short USD
    const block = portfolioBlock({ pairCode: 'USD/JPY', direction: 'SHORT' }, open, 0);
    expect(block?.code).toBe('USD_EXPOSURE');
    expect(block?.reason).toMatch(/short USD/);
    expect(portfolioBlock({ pairCode: 'USD/JPY', direction: 'LONG' }, open, 0)).toBeNull();
    // The same pair is managed by the open-trade rules, not this one.
    expect(portfolioBlock({ pairCode: 'EUR/USD', direction: 'LONG' }, open, 0)).toBeNull();
  });

  it('stops new trades after the daily loss limit', () => {
    expect(portfolioBlock({ pairCode: 'EUR/USD', direction: 'LONG' }, [], -DAILY_LOSS_LIMIT_R)?.code).toBe('DAILY_LOSS_LIMIT');
    expect(portfolioBlock({ pairCode: 'EUR/USD', direction: 'LONG' }, [], -1.5)).toBeNull();
  });
});

describe('costs and room', () => {
  it('puts the target far enough out for 2R after costs', () => {
    // (reward − c) = 2 × (risk + c) with risk 17p, c 1.2p → reward 37.6p.
    const support = { timeframe: 'DAILY' as const, kind: 'PIVOT_LOW' as const, low: 1.1, high: 1.101 };
    const map = { price: 1.1018, zones: mergeZones([support], 1.1018, 0.003) };
    const res = planZoneTrade('EUR/USD', 'LONG', map, { reach: 0.002, minR: 2, maxRiskPips: 60, costPips: 1.2 });
    expect(costAllowance('EUR/USD', 2, 1.2)).toBeCloseTo(0.00036, 8);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.plan.targetPrice).toBeCloseTo(1.1043, 6); // 1.1005 + 37.6p, rounded out
  });

  it('keeps a buffer between the target and the next opposing zone', () => {
    const res = { timeframe: 'H4' as const, kind: 'PIVOT_HIGH' as const, low: 1.1048, high: 1.1052 };
    const map = { price: 1.102, zones: mergeZones([res], 1.102, 0.003) };
    const levels = { entryLow: 1.1, entryHigh: 1.101, targetPrice: 1.1045 };
    // 3 pips of room is less than the 5-pip buffer.
    expect(roomCheck('EUR/USD', 'LONG', map, levels).ok).toBe(false);
    expect(roomCheck('EUR/USD', 'LONG', map, { ...levels, targetPrice: 1.1042 }).ok).toBe(true);
  });
});

describe('Monte Carlo', () => {
  it('is deterministic and brackets the actual net result', () => {
    const rs = [1, -1, 2, -1, 0.33, -1, 1.33, -1, 2, -1];
    const a = monteCarlo(rs)!;
    expect(monteCarlo(rs)).toEqual(a);
    const net = rs.reduce((x, y) => x + y, 0);
    expect(a.netR.p5).toBeLessThan(net);
    expect(a.netR.p95).toBeGreaterThan(net);
    expect(a.maxDrawdownR.p95).toBeGreaterThanOrEqual(a.maxDrawdownR.p50);
    expect(monteCarlo([1])).toBeNull();
  });
});
