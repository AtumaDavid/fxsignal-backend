import { describe, expect, it } from 'vitest';
import {
  finalTarget,
  firstTarget,
  replayPath,
  settleFromCandles,
} from '../src/lib/predictions.js';
import { LONG_LEVELS, m15 } from './helpers.js';

const START = '2026-10-06T08:00:00Z';
const FILL: [number, number] = [1.1003, 1.1012];

describe('three take-profits with a trailing stop', () => {
  it('derives TP1 at +1R and TP3 one R beyond TP2', () => {
    expect(firstTarget(LONG_LEVELS)).toBeCloseTo(1.1025, 6);
    expect(finalTarget(LONG_LEVELS)).toBeCloseTo(1.1065, 6);
    expect(finalTarget({ ...LONG_LEVELS, direction: 'NEUTRAL' })).toBeNull();
  });

  it('stopped before TP1 is −1R and MISSED', () => {
    const candles = m15(START, [FILL, [1.098, 1.1004]]);
    const path = replayPath(LONG_LEVELS, candles);
    expect(path.state).toBe('stopped');
    expect(path.pips).toBe(-20);
    expect(settleFromCandles(LONG_LEVELS, candles).status).toBe('MISSED');
  });

  it('TP1 then back to entry is +⅓R (a win)', () => {
    const candles = m15(START, [FILL, [1.101, 1.1026], [1.1004, 1.102]]);
    const path = replayPath(LONG_LEVELS, candles);
    expect(path.state).toBe('target');
    expect(path.tpHits).toBe(1);
    expect(path.pips).toBeCloseTo(6.7, 1);
    const settled = settleFromCandles(LONG_LEVELS, candles);
    expect(settled.status).toBe('HIT');
    expect(settled.resolvedPrice).toBeCloseTo(1.1005, 6); // last third at entry
  });

  it('TP2 then back to TP1 is +1⅓R', () => {
    const candles = m15(START, [FILL, [1.101, 1.1046], [1.1024, 1.104]]);
    const path = replayPath(LONG_LEVELS, candles);
    expect(path.state).toBe('target');
    expect(path.tpHits).toBe(2);
    expect(path.pips).toBeCloseTo(26.7, 1);
    expect(settleFromCandles(LONG_LEVELS, candles).resolvedPrice).toBeCloseTo(
      1.1025,
      6
    );
  });

  it('all three targets is +2R, even inside one candle', () => {
    const slow = m15(START, [FILL, [1.101, 1.1046], [1.104, 1.1066]]);
    const fast = m15(START, [FILL, [1.101, 1.1066]]);
    for (const candles of [slow, fast]) {
      const path = replayPath(LONG_LEVELS, candles);
      expect(path.state).toBe('target');
      expect(path.tpHits).toBe(3);
      expect(path.pips).toBe(40);
    }
  });

  it('a stop moved on a candle protects only the next candles', () => {
    // TP1 and a dip to entry in the same candle: order unknown, still running.
    const candles = m15(START, [FILL, [1.1004, 1.1026, 1.102]]);
    const path = replayPath(LONG_LEVELS, candles);
    expect(path.state).toBe('running');
    expect(path.tpHits).toBe(1);
    expect(path.stopNow).toBeCloseTo(1.1005, 6);
    // ⅓ booked at +20p, ⅔ open at +15p.
    expect(path.pips).toBeCloseTo(16.7, 1);
  });

  it('assumes the stop first when stop and target trade in one candle', () => {
    const candles = m15(START, [FILL, [1.098, 1.103]]);
    expect(replayPath(LONG_LEVELS, candles).state).toBe('stopped');
  });

  it('no fill means no trade', () => {
    const candles = m15(START, [
      [1.1015, 1.103],
      [1.102, 1.104],
    ]);
    expect(replayPath(LONG_LEVELS, candles).state).toBe('waiting');
    const settled = settleFromCandles(LONG_LEVELS, candles);
    expect(settled.status).toBe('EXPIRED');
    expect(settled.movementPips).toBeNull();
  });

  it('neutral calls are never a trade', () => {
    const candles = m15(START, [FILL]);
    const neutral = { ...LONG_LEVELS, direction: 'NEUTRAL' };
    expect(replayPath(neutral, candles).state).toBe('neutral');
    expect(settleFromCandles(neutral, candles).movementPips).toBeNull();
  });

  it('older single-target signals keep the old rule', () => {
    const legacy = { ...LONG_LEVELS, target3Price: null };
    const candles = m15(START, [FILL, [1.101, 1.1046]]);
    const path = replayPath(legacy, candles);
    expect(path.state).toBe('target');
    expect(path.pips).toBe(40);
  });

  it('mirrors correctly for shorts', () => {
    const short = {
      pairCode: 'EUR/USD',
      direction: 'SHORT',
      entryLow: 1.1,
      entryHigh: 1.101,
      targetPrice: 1.0965,
      invalidationPrice: 1.1025,
      target3Price: 1.0945,
    };
    const candles = m15(START, [FILL, [1.0944, 1.1004]]);
    const path = replayPath(short, candles);
    expect(path.state).toBe('target');
    expect(path.tpHits).toBe(3);
    expect(path.pips).toBe(40);
  });
});
