import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/asyncRoute.js';

const router = Router();

export const PLANS = [
  {
    id: 'FREE',
    name: 'Free',
    price: '$0',
    cadence: 'forever',
    blurb: 'Explore the engine on both tracked pairs.',
    features: [
      'Two liquid majors',
      'Session signals: London, New York, Asia',
      'Weekend weekly outlook',
      '7-day history',
      'Personal trade journal',
    ],
    limits: { historyDays: 7, historyLimit: 50 },
  },
  {
    id: 'PRO',
    name: 'Pro',
    price: '$19',
    cadence: '/ month',
    blurb: 'For day traders who want the full context stack.',
    features: [
      'Everything in Free',
      '365-day signal history',
      'Performance breakdown by pair & session',
      'Up to 200 history rows per query',
    ],
    limits: { historyDays: 365, historyLimit: 200 },
  },
] as const;

export type PlanId = (typeof PLANS)[number]['id'];

export function planFor(id: string | null | undefined) {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}

router.get('/plans', (_req, res) => {
  res.json(PLANS);
});

/**
 * Current account: profile, plan and usage against plan limits.
 */
router.get(
  '/account',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = Number(req.user?.sub);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user)
      return res.status(401).json({ error: 'Account no longer exists.' });
    const plan = planFor(user.plan);
    const [totalSignals, hits, misses] = await Promise.all([
      prisma.prediction.count({ where: { continuesId: null } }),
      prisma.predictionOutcome.count({ where: { status: 'HIT' } }),
      prisma.predictionOutcome.count({ where: { status: 'MISSED' } }),
    ]);
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan,
        planStatus: user.planStatus,
        createdAt: user.createdAt,
      },
      plan,
      usage: {
        totalSignals,
        hits,
        misses,
        historyDays: plan.limits.historyDays,
      },
    });
  })
);

const checkoutSchema = z.object({
  plan: z.enum(['PRO', 'FREE']),
});

/**
 * Simulated checkout. Swap the body with a Stripe Checkout Session creation
 * (STRIPE_SECRET_KEY) and a webhook that flips `plan` on payment success —
 * the API surface (plan on the user, limits enforced in history.routes.ts)
 * already supports it.
 */
router.post(
  '/checkout',
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: 'Choose a valid plan.' });

    const userId = Number(req.user?.sub);
    const user = await prisma.user.update({
      where: { id: userId },
      data: { plan: parsed.data.plan, planStatus: 'ACTIVE' },
    });
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan,
        planStatus: user.planStatus,
        createdAt: user.createdAt,
      },
      plan: planFor(user.plan),
      checkout: 'simulated',
      message:
        parsed.data.plan === 'PRO'
          ? 'Pro activated (simulated checkout — connect Stripe for live billing).'
          : 'Moved back to the Free plan.',
    });
  })
);

export default router;
