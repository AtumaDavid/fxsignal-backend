import { describe, expect, it } from 'vitest';
import { groupStats, MIN_SAMPLE, type ScoredTrade } from '../src/lib/analytics.js';

const t = (over: Partial<ScoredTrade>): ScoredTrade => ({
  pairCode: 'EUR/USD',
  session: 'London',
  direction: 'LONG',
  r: 1,
  status: 'HIT',
  closedAt: '2026-10-01T10:00:00Z',
  entryTrigger: 'M15_CLOSE',
  strategy: null,
  features: { trend: 'TRENDING', newsInWindow: false },
  confidence: 70,
  ...over,
});

describe('signal-quality analytics', () => {
  it('groups by a dimension with expectancy and drawdown', () => {
    const trades = [
      t({ r: 2 }),
      t({ r: -1, status: 'MISSED' }),
      t({ session: 'New York', r: -1, status: 'MISSED' }),
    ];
    const groups = groupStats(trades, 'session');
    const london = groups.find((g) => g.key === 'London')!;
    expect(london.trades).toBe(2);
    expect(london.avgR).toBe(0.5);
    expect(london.winRate).toBe(50);
    expect(london.maxDrawdownR).toBe(1);
    expect(london.inconclusive).toBe(true); // far below MIN_SAMPLE
  });

  it('a large, consistently positive group is conclusive; one spanning zero is not', () => {
    const good = Array.from({ length: MIN_SAMPLE + 10 }, (_, i) =>
      t({ r: i % 3 === 0 ? -1 : 1.5, status: i % 3 === 0 ? 'MISSED' : 'HIT' })
    );
    expect(groupStats(good, 'pair')[0].inconclusive).toBe(false);
    const coin = Array.from({ length: MIN_SAMPLE + 10 }, (_, i) =>
      t({ r: i % 2 ? 1 : -1, status: i % 2 ? 'HIT' : 'MISSED' })
    );
    const g = groupStats(coin, 'pair')[0];
    expect(g.avgRLow).toBeLessThan(0);
    expect(g.avgRHigh).toBeGreaterThan(0);
    expect(g.inconclusive).toBe(true);
  });

  it('labels feature buckets', () => {
    expect(groupStats([t({ features: null })], 'news')[0].key).toBe('unknown');
    expect(groupStats([t({ confidence: 80 })], 'confidence')[0].key).toBe('75+');
  });
});
