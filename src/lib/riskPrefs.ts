import { z } from 'zod';

// Risk guardrail settings, shared by the risk routes and the alert fan-out.

export const riskPrefsSchema = z.object({
  enabled: z.boolean(),
  dailyLossPct: z.number().min(0.1).max(50).nullable(),
  maxTradesPerDay: z.number().int().min(1).max(50).nullable(),
  balance: z.number().positive().max(1e12).nullable(),
  currency: z.enum(['USD', 'EUR', 'JPY']),
  weeklyLossPct: z.number().min(0.1).max(80).nullable().default(null),
  maxOpenPositions: z.number().int().min(1).max(50).nullable().default(null),
  /** Net lots per currency (USD, EUR, JPY) across open journal trades. */
  maxCurrencyLots: z.number().positive().max(10_000).nullable().default(null),
  /** Pause new-signal alerts once equity is this % below its peak. */
  drawdownPausePct: z.number().min(1).max(90).nullable().default(null),
  maxRiskPerTradePct: z.number().min(0.1).max(20).nullable().default(null),
  /** Round-turn commission per standard lot, account currency (hand-logged trades). */
  commissionPerLot: z.number().min(0).max(1_000).nullable().default(null),
});

export type RiskPrefs = z.infer<typeof riskPrefsSchema>;

export const DEFAULT_RISK_PREFS: RiskPrefs = {
  enabled: false,
  dailyLossPct: 3,
  maxTradesPerDay: 3,
  balance: null,
  currency: 'USD',
  weeklyLossPct: 6,
  maxOpenPositions: 2,
  maxCurrencyLots: null,
  drawdownPausePct: 10,
  maxRiskPerTradePct: 2,
  commissionPerLot: null,
};

/** MT5 equity drawdown from its peak, and whether it pauses the user's alerts. */
export function mt5Drawdown(
  prefs: RiskPrefs,
  link: { lastEquity: unknown; peakEquity: unknown; lastSyncAt: Date | null } | null
): { equity: number; peak: number; drawdownPct: number; paused: boolean } | null {
  if (!link || link.lastEquity === null || link.peakEquity === null) return null;
  const equity = Number(link.lastEquity);
  const peak = Number(link.peakEquity);
  if (!(peak > 0)) return null;
  const drawdownPct = Number((((peak - equity) / peak) * 100).toFixed(2));
  return {
    equity,
    peak,
    drawdownPct,
    paused:
      prefs.enabled &&
      prefs.drawdownPausePct !== null &&
      drawdownPct >= prefs.drawdownPausePct,
  };
}

export function readRiskPrefs(value: unknown): RiskPrefs {
  const parsed = riskPrefsSchema.partial().safeParse(value ?? {});
  return { ...DEFAULT_RISK_PREFS, ...(parsed.success ? parsed.data : {}) };
}

