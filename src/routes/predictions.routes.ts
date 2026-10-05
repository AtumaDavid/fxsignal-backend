import { Router } from 'express';
import { z } from 'zod';
import { getPairPrediction } from '../lib/predictions.js';

const router = Router();
const pairSchema = z.enum(['EUR/USD', 'USD/JPY']);

router.get('/', async (req, res) => {
  const parsed = pairSchema.safeParse(req.query.pair ?? 'EUR/USD');
  if (!parsed.success)
    return res.status(400).json({ error: 'Pair must be EUR/USD or USD/JPY.' });

  try {
    const prediction = await getPairPrediction(parsed.data);
    if (!prediction) {
      return res
        .status(404)
        .json({ error: 'No active signal available for this pair.' });
    }
    res.json(prediction);
  } catch (error) {
    console.error(
      'Signal feed failed:',
      error instanceof Error ? error.message : error
    );
    res
      .status(503)
      .json({ error: 'The signal feed is unavailable right now.' });
  }
});

export default router;
