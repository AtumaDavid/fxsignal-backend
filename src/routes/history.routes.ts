import { Router } from 'express';
import { z } from 'zod';
import { getHistory } from '../lib/predictions.js';
import { buildPerformance } from '../lib/performance.js';
import { prisma } from '../lib/prisma.js';
import { planFor } from './billing.routes.js';
import type { PairCode } from '../lib/model.js';

const router = Router();

const SESSIONS = [
  'Asia',
  'Tokyo',
  'London',
  'London / New York',
  'New York',
  'Asia pre-open',
] as const;

const querySchema = z.object({
  pair: z.enum(['EUR/USD', 'USD/JPY']).optional(),
  session: z.enum(SESSIONS).optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

async function planForRequest(sub: string | undefined) {
  const userId = Number(sub);
  const user = Number.isFinite(userId)
    ? await prisma.user.findUnique({ where: { id: userId } })
    : null;
  return planFor(user?.plan);
}

/**
 * Completed signals. The response says which window was actually applied,
 * because plan limits can narrow what the caller asked for (Free keeps 7 days,
 * Pro unlocks the full year) and the UI should say so rather than silently
 * showing less.
 */
router.get('/', async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success)
    return res.status(400).json({ error: 'Invalid history query.' });

  try {
    const plan = await planForRequest(req.user?.sub);
    const days = Math.min(parsed.data.days, plan.limits.historyDays);
    const limit = Math.min(parsed.data.limit, plan.limits.historyLimit);

    // Filtered in the database (not in memory) so pair/session pages are exact.
    const items = await getHistory(limit, new Date(), {
      days,
      session: parsed.data.session,
      pair: parsed.data.pair as PairCode | undefined,
    });
    return res.json({
      items,
      appliedDays: days,
      appliedLimit: limit,
      requestedDays: parsed.data.days,
      plan: plan.id,
      capped: days < parsed.data.days,
    });
  } catch (error) {
    console.warn(
      'History unavailable:',
      error instanceof Error ? error.message : error
    );
    return res
      .status(503)
      .json({ error: 'The signal journal is unavailable right now.' });
  }
});

/** Aggregated track record over the plan's history window. */
router.get('/performance', async (req, res) => {
  const parsed = z
    .object({ days: z.coerce.number().int().min(1).max(365).default(365) })
    .safeParse(req.query);
  if (!parsed.success)
    return res.status(400).json({ error: 'Invalid performance query.' });

  try {
    const plan = await planForRequest(req.user?.sub);
    const days = Math.min(parsed.data.days, plan.limits.historyDays);
    const rows = await getHistory(1000, new Date(), { days, maxRows: 1000 });
    return res.json({
      ...buildPerformance(rows),
      appliedDays: days,
      plan: plan.id,
      capped: days < parsed.data.days,
    });
  } catch (error) {
    console.warn(
      'Performance unavailable:',
      error instanceof Error ? error.message : error
    );
    return res
      .status(503)
      .json({ error: 'Performance data is unavailable right now.' });
  }
});

export default router;
