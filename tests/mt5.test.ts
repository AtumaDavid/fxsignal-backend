import { describe, expect, it } from 'vitest';
import { aggregatePositions, matchSignal, pairFromSymbol, type Mt5Position } from '../src/lib/mt5.js';

const t = (iso: string) => Date.parse(iso) / 1000;
const signal = (id: number, pairCode: string, direction: string, from: string, to: string) => ({
  id,
  pairCode,
  direction,
  validFrom: new Date(from),
  expiresAt: new Date(to),
});
const pos = (over: Partial<Mt5Position>): Mt5Position => ({
  id: '1',
  symbol: 'EURUSDm',
  side: 'SELL',
  openTime: t('2026-10-05T09:20:00Z'),
  openPrice: 1.172,
  volume: 0.1,
  sl: 1.175,
  tp: 1.169,
  closedVolume: 0,
  ...over,
});

describe('MT5 sync', () => {
  it('reads broker symbols with suffixes', () => {
    expect(pairFromSymbol('EURUSDm')).toBe('EUR/USD');
    expect(pairFromSymbol('EURUSD.raw')).toBe('EUR/USD');
    expect(pairFromSymbol('usdjpy')).toBe('USD/JPY');
    expect(pairFromSymbol('GBPUSD')).toBeNull();
  });

  it('matches the signal of the same pair and direction opened in its window', () => {
    const signals = [
      signal(1, 'EUR/USD', 'SHORT', '2026-10-05T07:00:00Z', '2026-10-05T12:00:00Z'),
      signal(2, 'EUR/USD', 'LONG', '2026-10-05T07:00:00Z', '2026-10-05T12:00:00Z'),
      signal(3, 'EUR/USD', 'SHORT', '2026-10-05T09:00:00Z', '2026-10-05T12:00:00Z'),
    ];
    expect(matchSignal(pos({}), signals)?.id).toBe(3); // newest wins
    expect(matchSignal(pos({ side: 'BUY' }), signals)?.id).toBe(2);
    expect(matchSignal(pos({ openTime: t('2026-10-05T15:00:00Z') }), signals)).toBeNull();
  });

  it('merges several positions on one signal into one journal trade', () => {
    const fill = aggregatePositions([
      pos({ id: 'a', closedVolume: 0.1, closePrice: 1.1695, closeTime: t('2026-10-05T11:00:00Z') }),
      pos({ id: 'b', openPrice: 1.1718, sl: 1.172, closedVolume: 0.1, closePrice: 1.172, closeTime: t('2026-10-05T11:30:00Z') }),
    ]);
    expect(fill.side).toBe('SHORT');
    expect(fill.lots).toBe(0.2);
    expect(fill.entryPrice).toBeCloseTo(1.1719, 6);
    expect(fill.exitPrice).toBeCloseTo(1.17075, 6);
    expect(fill.stopPrice).toBe(1.172); // tightest stop for a short
    expect(fill.targetPrice).toBe(1.169);
    expect(fill.exitedAt?.toISOString()).toBe('2026-10-05T11:30:00.000Z');
    expect(fill.externalRef).toBe('a,b');
  });

  it('stays open until every position is fully closed', () => {
    const fill = aggregatePositions([
      pos({ id: 'a', closedVolume: 0.1, closePrice: 1.1695, closeTime: t('2026-10-05T11:00:00Z') }),
      pos({ id: 'b' }),
    ]);
    expect(fill.exitPrice).toBeNull();
    expect(fill.exitedAt).toBeNull();
  });
});
