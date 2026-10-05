import { Router } from 'express';
import { z } from 'zod';
import { candleTime } from '../lib/liveData.js';
import { peekStale } from '../lib/rateCache.js';
import type { Candle } from '../lib/technical.js';

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

export default router;
