import { describe, expect, it } from 'vitest';
import {
  decideOnH1Close,
  lifecycleStage,
  noPositionReason,
  replayPath,
  settleFromCandles,
} from '../src/lib/predictions.js';
import { strategySnapshot } from '../src/lib/strategy.js';
import type { Candle } from '../src/lib/technical.js';
import { LONG_LEVELS } from './helpers.js';

function bars(rows: [number, number, number, number][]): Candle[] {
  let t = Date.parse('2026-10-06T08:00:00Z');
  return rows.map(([open, high, low, close]) => {
    const datetime = new Date(t).toISOString().slice(0, 19).replace('T', ' ');
    t += 15 * 60_000;
    return { datetime, open, high, low, close };
  });
}
const ROW = { ...LONG_LEVELS, entryTrigger: 'M15_CLOSE' as const };
const AWAY: [number, number, number, number] = [1.1013, 1.1018, 1.1012, 1.1016];

describe('lifecycle stages', () => {
  it('waiting → in zone → entered → TP1', () => {
    expect(lifecycleStage(replayPath(ROW, bars([AWAY])))).toBe('WAITING_FOR_ZONE');
    const inZone = bars([AWAY, [1.1012, 1.1014, 1.1004, 1.1006]]);
    expect(lifecycleStage(replayPath(ROW, inZone))).toBe('IN_ZONE');
    const entered = bars([[1.1005, 1.1009, 1.1002, 1.1008]]);
    expect(lifecycleStage(replayPath(ROW, entered))).toBe('ENTERED');
    const tp1 = bars([[1.1005, 1.1009, 1.1002, 1.1008], [1.1008, 1.1026, 1.1007, 1.102]]);
    expect(lifecycleStage(replayPath(ROW, tp1))).toBe('TP1');
  });

  it('a dead setup is VOID with its reason', () => {
    const path = replayPath(ROW, bars([[1.1006, 1.1008, 1.0982, 1.0984]]));
    expect(lifecycleStage(path)).toBe('VOID');
    expect(path.voidReason).toBe('STOP_BEFORE_ENTRY');
  });
});

describe('no-position reasons', () => {
  it('names why a published trade never filled', () => {
    expect(noPositionReason(replayPath(ROW, bars([AWAY])))).toBe('NO_TOUCH');
    const touchBearish = bars([[1.1012, 1.1014, 1.1004, 1.1006]]);
    expect(noPositionReason(replayPath(ROW, touchBearish))).toBe('NO_CONFIRMATION');
    const stale = bars([[1.1012, 1.1014, 1.1004, 1.1006], AWAY, AWAY, AWAY, AWAY, AWAY]);
    expect(noPositionReason(replayPath(ROW, stale))).toBe('CONFIRMATION_EXPIRED');
    const news = { ...ROW, blackouts: [{ from: 0, to: Date.parse('2026-10-07T00:00:00Z'), title: 'x' }] };
    expect(noPositionReason(replayPath(news, bars([[1.1005, 1.1009, 1.1002, 1.1008]])))).toBe('NEWS_BLACKOUT');
  });

  it('settles with the reason code and a matching note', () => {
    const s = settleFromCandles(ROW, bars([[1.1006, 1.1008, 1.0982, 1.0984]]));
    expect(s.status).toBe('EXPIRED');
    expect(s.reasonCode).toBe('STOP_BEFORE_ENTRY');
    expect(s.note).toMatch(/invalidation level traded before any confirmation/);
  });

  it('H1 cancellations carry a code', () => {
    const d = decideOnH1Close({
      direction: 'LONG',
      state: 'waiting',
      entryLow: 1.1,
      entryHigh: 1.101,
      invalidationPrice: 1.0985,
      h1Close: 1.098,
      h1Score: 0,
      h4Score: 0,
      contextScore: 30,
    });
    expect(d.action).toBe('cancel');
    expect(d.code).toBe('H1_INVALIDATION');
  });
});

describe('strategy versioning', () => {
  it('the same rules give the same fingerprint, different rules a different one', () => {
    const a = strategySnapshot({ levelModel: 'atr', entryTrigger: 'M15_CLOSE', confirmWindowBars: 4 });
    const b = strategySnapshot({ levelModel: 'atr', entryTrigger: 'M15_CLOSE', confirmWindowBars: 4 });
    const c = strategySnapshot({ levelModel: 'atr', entryTrigger: 'M15_CLOSE', confirmWindowBars: 6 });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
    expect(a.costs['EUR/USD']).toBeGreaterThan(0);
    expect(a.zoneEngine).toBeNull();
  });
});
