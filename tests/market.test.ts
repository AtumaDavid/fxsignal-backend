import { describe, expect, it } from 'vitest';
import {
  isForexOpen,
  nextMarketClose,
  nextWindowStart,
  tradingWindowAt,
} from '../src/lib/market.js';
import { buildDayTradeLevels, enforceMinRewardRisk } from '../src/lib/technical.js';
import { riskFor } from '../src/lib/predictions.js';

describe('market hours and session windows', () => {
  it('is closed at the weekend', () => {
    expect(isForexOpen(new Date('2026-10-10T12:00:00Z'))).toBe(false); // Sat
    expect(isForexOpen(new Date('2026-10-11T21:59:00Z'))).toBe(false); // Sun
    expect(isForexOpen(new Date('2026-10-11T22:00:00Z'))).toBe(true);
    expect(isForexOpen(new Date('2026-10-09T22:00:00Z'))).toBe(false); // Fri close
  });

  it('maps hours to Asia / London / New York and nothing in the evening', () => {
    expect(tradingWindowAt(new Date('2026-10-06T03:00:00Z'))?.label).toBe('Asia');
    expect(tradingWindowAt(new Date('2026-10-06T07:00:00Z'))?.label).toBe('London');
    expect(tradingWindowAt(new Date('2026-10-06T12:30:00Z'))?.label).toBe('New York');
    expect(tradingWindowAt(new Date('2026-10-06T18:00:00Z'))).toBeNull();
    expect(tradingWindowAt(new Date('2026-10-06T07:00:00Z'))?.key).toBe('2026-10-06-LONDON');
  });

  it('finds the next window across the evening and the weekend', () => {
    expect(nextWindowStart(new Date('2026-10-06T18:00:00Z')).toISOString()).toBe(
      '2026-10-07T00:00:00.000Z'
    );
    expect(nextWindowStart(new Date('2026-10-09T18:00:00Z')).toISOString()).toBe(
      '2026-10-12T00:00:00.000Z'
    );
  });

  it('holds trades until the Friday close of their week', () => {
    expect(nextMarketClose(new Date('2026-10-06T08:00:00Z')).toISOString()).toBe(
      '2026-10-09T22:00:00.000Z'
    );
  });
});

describe('levels', () => {
  it('builds at least 1:2 from the zone midpoint', () => {
    const levels = buildDayTradeLevels('EUR/USD', 'LONG', 1.1, 0.0015, 1.1012, 1.0975);
    expect(levels.tradeable).toBe(true);
    const risk = riskFor({ pairCode: 'EUR/USD', ...levels });
    expect(risk.riskReward).toBeGreaterThanOrEqual(2);
  });

  it('stands aside when the structural stop is too wide', () => {
    const levels = buildDayTradeLevels('EUR/USD', 'LONG', 1.1, 0.0015, 1.11, 1.09);
    expect(levels.tradeable).toBe(false);
  });

  it('pushes a model target closer than 2R out to 2R', () => {
    const fixed = enforceMinRewardRisk({
      pairCode: 'EUR/USD',
      direction: 'LONG',
      entryLow: 1.1,
      entryHigh: 1.101,
      targetPrice: 1.102,
      invalidationPrice: 1.0985,
    });
    expect(fixed).not.toBeNull();
    expect(riskFor({ pairCode: 'EUR/USD', ...fixed! }).riskReward).toBeGreaterThanOrEqual(2);
  });
});
