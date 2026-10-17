import { Router } from 'express';
import { z } from 'zod';
import { candleTime } from '../lib/liveData.js';
import { peekStale } from '../lib/rateCache.js';
import type { Candle, Timeframe } from '../lib/technical.js';
import { buildZoneMap } from '../lib/zones.js';

const router = Router();

const querySchema = z.object({
  pair: z.enum(['EUR/USD', 'USD/JPY']),
  timeframe: z.enum(['M15', 'H1', 'H4', 'DAILY', 'WEEKLY', 'MONTHLY']),
});

/**
 * Candles for the signal and outlook charts, served straight from the cache
 * the engine fills while it builds signals. Read-only: chart views never spend
 * provider credits. `asOf` is the newest candle, so the UI can say how fresh
 * the picture is.
 */
router.get('/', async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success)
    return res
      .status(400)
      .json({ error: 'Choose a supported pair and timeframe.' });

  const { pair, timeframe } = parsed.data;
  try {
    const cached = await peekStale<Candle[]>(
      `twelvedata:tf:${pair}:${timeframe}`
    );
    const candles = (cached ?? [])
      .map((candle) => ({
        time: Math.floor(candleTime(candle) / 1000),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      }))
      .filter((candle) => Number.isFinite(candle.time))
      .sort((a, b) => a.time - b.time)
      // Duplicate timestamps break the chart's time scale.
      .filter(
        (candle, index, all) =>
          index === 0 || candle.time !== all[index - 1].time
      );
    res.json({
      pair,
      timeframe,
      candles,
      asOf:
        candles.length > 0
          ? new Date(candles[candles.length - 1].time * 1000).toISOString()
          : null,
    });
  } catch (error) {
    console.warn(
      'Candles unavailable:',
      error instanceof Error ? error.message : error
    );
    res.status(503).json({ error: 'Chart data is unavailable right now.' });
  }
});

const zonesQuery = z.object({ pair: z.enum(['EUR/USD', 'USD/JPY']) });

/**
 * The zone map for a pair, for the chart: merged zones (support/resistance,
 * demand/supply, order blocks, liquidity highs/lows) from the cached
 * Daily/H4/H1/M15 candles, plus the previous month's high/low for context.
 * Read-only from the cache, like the candles.
 */
router.get('/zones', async (req, res) => {
  const parsed = zonesQuery.safeParse(req.query);
  if (!parsed.success)
    return res.status(400).json({ error: 'Choose a supported pair.' });
  const { pair } = parsed.data;
  try {
    const read = (tf: Timeframe) =>
      peekStale<Candle[]>(`twelvedata:tf:${pair}:${tf}`).then((c) => c ?? []);
    const [daily, h4, h1, m15] = await Promise.all([
      read('DAILY'),
      read('H4'),
      read('H1'),
      read('M15'),
    ]);
    const newest = [...m15, ...h1].sort((a, b) => candleTime(b) - candleTime(a))[0];
    if (!newest || daily.length < 20)
      return res.json({ pair, price: null, zones: [], monthly: null });
    const now = Date.now();
    const map = buildZoneMap(pair, { DAILY: daily, H4: h4, H1: h1, M15: m15 }, newest.close, now);

    // Previous calendar month's high/low (context only; not an engine source).
    const monthStart = new Date(now);
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const prevStart = new Date(monthStart);
    prevStart.setUTCMonth(prevStart.getUTCMonth() - 1);
    const prevMonth = daily.filter((c) => {
      const t = candleTime(c);
      return t >= prevStart.getTime() && t < monthStart.getTime();
    });
    res.json({
      pair,
      price: newest.close,
      zones: map.zones.map((zone) => ({
        low: zone.low,
        high: zone.high,
        label: zone.label,
        score: zone.score,
        higherTimeframe: zone.higherTimeframe,
        role: (zone.low + zone.high) / 2 <= newest.close ? 'support' : 'resistance',
        kinds: [...new Set(zone.sources.map((s) => s.kind))],
        timeframes: [...new Set(zone.sources.map((s) => s.timeframe))],
      })),
      monthly: prevMonth.length
        ? {
            high: Math.max(...prevMonth.map((c) => c.high)),
            low: Math.min(...prevMonth.map((c) => c.low)),
          }
        : null,
    });
  } catch (error) {
    console.warn('Zones unavailable:', error instanceof Error ? error.message : error);
    res.status(503).json({ error: 'Zones are unavailable right now.' });
  }
});

export default router;
