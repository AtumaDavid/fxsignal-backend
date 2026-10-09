import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { asyncRoute } from '../middleware/asyncRoute.js';

/**
 * Risk guardrails: a daily loss limit (% of the account) and a maximum number
 * of trades per day, checked against the user's journal. Off by default; the
 * app only warns, it never blocks a trade.
 */
const router = Router();

export const riskPrefsSchema = z.object({
  enabled: z.boolean(),
  dailyLossPct: z.number().min(0.1).max(50).nullable(),
  maxTradesPerDay: z.number().int().min(1).max(50).nullable(),
  balance: z.number().positive().max(1e12).nullable(),
  currency: z.enum(['USD', 'EUR', 'JPY']),
});

export type RiskPrefs = z.infer<typeof riskPrefsSchema>;

export const DEFAULT_RISK_PREFS: RiskPrefs = {
  enabled: false,
  dailyLossPct: 3,
  maxTradesPerDay: 3,
  balance: null,
  currency: 'USD',
};

export function readRiskPrefs(value: unknown): RiskPrefs {
  const parsed = riskPrefsSchema.partial().safeParse(value ?? {});
  return { ...DEFAULT_RISK_PREFS, ...(parsed.success ? parsed.data : {}) };
}

router.get(
  '/',
  asyncRoute(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: Number(req.user?.sub) },
      select: { riskPrefs: true },
    });
    res.json({ prefs: readRiskPrefs(user?.riskPrefs) });
  })
);

router.put(
  '/',
  asyncRoute(async (req, res) => {
    const parsed = riskPrefsSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid guardrail settings.',
      });
    await prisma.user.update({
      where: { id: Number(req.user?.sub) },
      data: { riskPrefs: parsed.data as Prisma.InputJsonValue },
    });
    res.json({ prefs: parsed.data });
  })
);

export default router;
