import { Router } from 'express';
import {
  getDashboardFromDatabase,
  maintainMarketData,
} from '../lib/predictions.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    // `?refresh=1` is only used by the explicit "Retry" action in the UI. It
    // runs a forced maintenance pass (bypassing the AI cooldown) so the user
    // gets a genuine re-attempt at the live providers. Plain loads stay
    // read-only and never call the providers.
    if (req.query.refresh === '1') {
      await maintainMarketData(new Date(), { force: true });
    }
    res.json(await getDashboardFromDatabase());
  } catch (error) {
    console.error(
      'Dashboard failed:',
      error instanceof Error ? error.message : error
    );
    res.status(503).json({ error: 'Market data is unavailable right now.' });
  }
});

export default router;
