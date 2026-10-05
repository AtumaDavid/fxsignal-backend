import { Router } from 'express';
import { z } from 'zod';
import {
  getOrCreateWeeklyOutlook,
  getWeeklyOutlook,
  maintainMarketData,
  targetWeek,
} from '../lib/predictions.js';

const router = Router();

const querySchema = z.object({
  weekKey: z
    .string()
    .regex(/^\d{4}-W\d{2}$/, 'Week key must look like 2026-W40.')
    .optional(),
});

/**
 * Weekend outlook for the coming trading week, built top-down
 * (monthly → weekly → daily → H4 → H1). Read-only by default — generation is
 * owned by background maintenance. `?refresh=1` forces a regeneration pass.
 */
router.get('/weekly', async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success)
    return res.status(400).json({ error: 'Invalid week requested.' });

  try {
    if (req.query.refresh === '1') {
      await maintainMarketData(new Date(), { force: true });
    }
    const currentKey = targetWeek(new Date()).weekKey;
    const weekKey = parsed.data.weekKey ?? currentKey;
    const outlook = await getWeeklyOutlook(weekKey);
    if (outlook.length === 0 && weekKey !== currentKey) {
      // Only the current week can be generated; other weeks are archive reads.
      return res
        .status(404)
        .json({ error: `No outlook was published for ${weekKey}.` });
    }
    if (outlook.length === 0) {
      // No stored outlook yet — try one genuine generation pass before
      // answering honestly with an empty state.
      const generated = await getOrCreateWeeklyOutlook(new Date(), {
        force: req.query.refresh === '1' ? true : undefined,
      });
      if (generated.length === 0) {
        return res.status(404).json({
          error:
            'The weekly outlook is not available yet. Connect the market feed and try again.',
        });
      }
      return res.json(generated);
    }
    res.json(outlook);
  } catch (error) {
    console.error(
      'Weekly outlook failed:',
      error instanceof Error ? error.message : error
    );
    res
      .status(503)
      .json({ error: 'The weekly outlook is unavailable right now.' });
  }
});

export default router;
