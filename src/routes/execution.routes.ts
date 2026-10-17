import { Router } from 'express';
import { PAIRS } from '../lib/market.js';
import { liveSpread, MAX_SPREAD_PIPS } from '../lib/execution.js';
import { EXECUTION_COST_PIPS } from '../lib/risk.js';
import { asyncRoute } from '../middleware/asyncRoute.js';

/**
 * Live execution conditions: the current spread per pair (from MT5 terminals
 * running the Sync EA), the limit above which no new trade is published, and
 * the cost the engine and backtest assume.
 */
const router = Router();

router.get(
  '/',
  asyncRoute(async (_req, res) => {
    const spreads = await Promise.all(
      PAIRS.map(async (pair) => ({
        pairCode: pair,
        live: await liveSpread(pair),
        maxSpreadPips: MAX_SPREAD_PIPS[pair],
        assumedCostPips: EXECUTION_COST_PIPS[pair],
      }))
    );
    res.json({ spreads });
  })
);

export default router;
