import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { asyncRoute } from '../middleware/asyncRoute.js';
import { mt5Drawdown, readRiskPrefs, riskPrefsSchema } from '../lib/riskPrefs.js';

/**
 * Risk guardrails, checked against the user's journal (and the MT5 account
 * snapshot when the Sync EA runs): daily and weekly loss limits, trades per
 * day, open positions, per-currency exposure, risk per trade and a drawdown
 * pause. Off by default. The app warns and never blocks a trade; past the
 * drawdown limit it also stops sending that user new-signal alerts.
 */
const router = Router();

export {
  DEFAULT_RISK_PREFS,
  mt5Drawdown,
  readRiskPrefs,
  riskPrefsSchema,
  type RiskPrefs,
} from '../lib/riskPrefs.js';

router.get(
  '/',
  asyncRoute(async (req, res) => {
    const userId = Number(req.user?.sub);
    const [user, link] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { riskPrefs: true } }),
      prisma.mt5Link.findUnique({ where: { userId } }),
    ]);
    const prefs = readRiskPrefs(user?.riskPrefs);
    res.json({
      prefs,
      mt5: link
        ? {
            ...mt5Drawdown(prefs, link),
            currency: link.lastCurrency,
            balance: link.lastBalance === null ? null : Number(link.lastBalance),
            syncedAt: link.lastSyncAt?.toISOString() ?? null,
          }
        : null,
    });
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
