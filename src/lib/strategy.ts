import { createHash } from 'node:crypto';
import type { EntryTrigger } from './model.js';
import {
  DAILY_LOSS_LIMIT_R,
  EXECUTION_COST_PIPS,
  NEWS_BLACKOUT_AFTER_MS,
  NEWS_BLACKOUT_BEFORE_MS,
} from './risk.js';
import { MAX_RISK_PIPS, MIN_REWARD_RISK } from './technical.js';
import { ROOM_BUFFER_PIPS } from './zones.js';

// ---- Strategy versioning --------------------------------------------------------
//
// Every signal and backtest run stores the rules it was built with, so
// results from different rules are never compared as if they were the same.
// Bump STRATEGY_VERSION when a rule changes on purpose; the fingerprint (a
// hash of every setting) changes on its own whenever any value does, so an
// unversioned change still shows up.

export const STRATEGY_VERSION = '2026.10.4';

/** Entry-trigger rule versions: what "M15_CLOSE" meant at each step. */
const TRIGGER_VERSION: Record<EntryTrigger, string> = {
  TOUCH: 'touch-v1',
  // v2: confirmation expiry, no chase after TP1, news blackout.
  M15_CLOSE: 'm15-close-v2',
};

export interface StrategySnapshot {
  version: string;
  /** Hash of everything below; equal fingerprints = identical rules. */
  fingerprint: string;
  levelModel: 'atr' | 'zones';
  zoneEngine: string | null;
  entryTrigger: EntryTrigger;
  triggerVersion: string;
  confirmWindowBars: number;
  /** Direction / regime filters in force. */
  filters: Record<string, unknown> | null;
  /** When pairs are re-read inside a window. */
  scans: string | null;
  setupCooldownHours: number | null;
  costs: Record<string, number>;
  risk: {
    minRewardRisk: number;
    maxRiskPips: number;
    dailyLossLimitR: number;
    usdExposureCap: boolean;
    roomBufferPips: number | null;
  };
  news: { blackoutBeforeMin: number; blackoutAfterMin: number };
}

export function strategySnapshot(engine: {
  levelModel: 'atr' | 'zones';
  entryTrigger: EntryTrigger;
  confirmWindowBars: number;
  filters?: Record<string, unknown>;
  scans?: string;
  setupCooldownHours?: number;
}): StrategySnapshot {
  const body = {
    version: STRATEGY_VERSION,
    levelModel: engine.levelModel,
    zoneEngine: engine.levelModel === 'zones' ? 'zones-v1' : null,
    entryTrigger: engine.entryTrigger,
    triggerVersion: TRIGGER_VERSION[engine.entryTrigger],
    confirmWindowBars: engine.confirmWindowBars,
    filters: engine.filters ?? null,
    scans: engine.scans ?? null,
    setupCooldownHours: engine.setupCooldownHours ?? null,
    costs: { ...EXECUTION_COST_PIPS },
    risk: {
      minRewardRisk: MIN_REWARD_RISK,
      maxRiskPips: MAX_RISK_PIPS,
      dailyLossLimitR: DAILY_LOSS_LIMIT_R,
      usdExposureCap: true,
      roomBufferPips: engine.levelModel === 'zones' ? ROOM_BUFFER_PIPS : null,
    },
    news: {
      blackoutBeforeMin: NEWS_BLACKOUT_BEFORE_MS / 60_000,
      blackoutAfterMin: NEWS_BLACKOUT_AFTER_MS / 60_000,
    },
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(body))
    .digest('hex')
    .slice(0, 10);
  return { ...body, fingerprint };
}

/** "2026.10.3 · 3f9a1c22b0", for display. */
export function strategyLabel(s: { version: string; fingerprint: string } | null) {
  return s ? `${s.version} · ${s.fingerprint}` : 'unversioned';
}
