import { describe, expect, it } from 'vitest';
import { slippagePips, spreadPips } from '../src/lib/execution.js';
import { fetchOandaHistory, toMidCandle } from '../src/lib/oanda.js';
import { aggregatePositions } from '../src/lib/mt5.js';

describe('execution data', () => {
  it('spread and slippage in pips, signed against the trader', () => {
    expect(spreadPips('EUR/USD', 1.1, 1.10012)).toBe(1.2);
    expect(spreadPips('USD/JPY', 150, 150.015)).toBe(1.5);
    // Bought 0.8p above the signal's fill: 0.8p worse.
    expect(slippagePips('EUR/USD', 'LONG', 1.1, 1.10008)).toBe(0.8);
    // Sold 0.5p above the fill: better.
    expect(slippagePips('EUR/USD', 'SHORT', 1.1, 1.10005)).toBe(-0.5);
  });

  it('sums broker commission and swap across positions', () => {
    const base = { symbol: 'EURUSD', side: 'BUY' as const, openTime: 1, openPrice: 1.1, volume: 0.5, sl: 0, tp: 0, closedVolume: 0 };
    const fill = aggregatePositions([
      { ...base, id: '1', commission: -3.5, swap: -0.2 },
      { ...base, id: '2', commission: -3.5 },
    ]);
    expect(fill.commission).toBe(-7);
    expect(fill.swap).toBe(-0.2);
    expect(aggregatePositions([{ ...base, id: '3' }]).commission).toBeNull();
  });
});

describe('OANDA bid/ask history', () => {
  const candle = (time: string, bid: number, ask: number) => ({
    time,
    complete: true,
    bid: { o: String(bid), h: String(bid + 0.001), l: String(bid - 0.001), c: String(bid) },
    ask: { o: String(ask), h: String(ask + 0.001), l: String(ask - 0.001), c: String(ask) },
  });

  it('builds mid candles and keeps the closing spread', () => {
    const c = toMidCandle(candle('2026-10-06T08:15:00.000000000Z', 1.1, 1.10012), false)!;
    expect(c.datetime).toBe('2026-10-06 08:15:00');
    expect(c.close).toBeCloseTo(1.10006, 8);
    expect(c.spread).toBeCloseTo(0.00012, 8);
    expect(toMidCandle({ ...candle('2026-10-06T00:00:00Z', 1, 1), complete: false }, true)).toBeNull();
  });

  it('pages through the API with the token', async () => {
    process.env.OANDA_API_TOKEN = 'test-token';
    const calls: string[] = [];
    const fetcher = async (url: string, init: { headers: Record<string, string> }) => {
      calls.push(url);
      expect(init.headers.Authorization).toBe('Bearer test-token');
      return {
        ok: true,
        status: 200,
        json: async () => ({ candles: [candle('2030-01-01T00:00:00Z', 1.1, 1.1001), candle('2030-01-01T00:15:00Z', 1.1, 1.1002)] }),
      };
    };
    const out = await fetchOandaHistory(
      'EUR/USD',
      'M15',
      new Date('2030-01-01T00:00:00Z'),
      new Date('2030-01-01T00:20:00Z'),
      { fetcher, cache: false }
    );
    expect(out).toHaveLength(2);
    expect(calls[0]).toContain('/v3/instruments/EUR_USD/candles');
    expect(calls[0]).toContain('price=BA');
    delete process.env.OANDA_API_TOKEN;
  });
});
