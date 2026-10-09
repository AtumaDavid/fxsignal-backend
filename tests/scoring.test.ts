import { describe, expect, it } from 'vitest';
import { buildPerformance } from '../src/lib/performance.js';
import { buildRecap } from '../src/lib/recap.js';
import type { OutcomeStatus } from '../src/lib/model.js';
import { prediction } from './helpers.js';

const scored = (status: OutcomeStatus, pips: number | null, extra = {}) =>
  prediction({
    outcome: {
      status,
      movementPips: pips,
      resolvedPrice: null,
      evaluatedAt: null,
      source: 'LIVE',
      note: null,
    },
    ...extra,
  });

describe('track record', () => {
  it('keeps breakevens and early exits out of the hit rate but in net pips', () => {
    const perf = buildPerformance([
      scored('HIT', 40),
      scored('MISSED', -20),
      scored('BREAKEVEN', 0),
      scored('CLOSED_EARLY', -5),
      scored('CANCELLED', null),
      scored('EXPIRED', null, { direction: 'NEUTRAL' }),
    ]);
    expect(perf.totals.hits).toBe(1);
    expect(perf.totals.misses).toBe(1);
    expect(perf.totals.hitRate).toBe(50);
    expect(perf.totals.netPips).toBe(15);
    expect(perf.totals.breakeven).toBe(1);
    expect(perf.totals.closedEarly).toBe(1);
    expect(perf.totals.cancelled).toBe(1);
    expect(perf.totals.neutral).toBe(1);
  });
});

describe('weekly recap', () => {
  it('sums R and pips, finds best and worst, splits by day', () => {
    const recap = buildRecap(
      new Date('2026-10-05T00:00:00Z'),
      [
        scored('HIT', 40, { id: 'a', validFrom: '2026-10-05T07:00:00.000Z' }),
        scored('MISSED', -20, { id: 'b', validFrom: '2026-10-06T07:00:00.000Z' }),
        scored('EXPIRED', null, { id: 'c', validFrom: '2026-10-06T12:00:00.000Z' }),
        scored('PENDING', null, { id: 'd', validFrom: '2026-10-07T07:00:00.000Z' }),
      ],
      [{ pips: 12 }, { pips: -4 }, { pips: null }],
      ['2026-10-05']
    );
    expect(recap.engine.netR).toBe(1);
    expect(recap.engine.netPips).toBe(20);
    expect(recap.engine.winRate).toBe(50);
    expect(recap.engine.best?.id).toBe('a');
    expect(recap.engine.worst?.id).toBe('b');
    expect(recap.engine.notTriggered).toBe(1);
    expect(recap.engine.open).toBe(1);
    expect(recap.days[0]).toMatchObject({ date: '2026-10-05', netPips: 40, trades: 1 });
    expect(recap.you).toMatchObject({ logged: 3, closed: 2, wins: 1, losses: 1, netPips: 8 });
  });
});
