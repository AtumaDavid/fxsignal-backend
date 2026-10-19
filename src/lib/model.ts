import { nextWindowStart } from './market.js';
export type PairCode = 'EUR/USD' | 'USD/JPY';
export type Direction = 'LONG' | 'SHORT' | 'NEUTRAL';
export type Impact = 'LOW' | 'MEDIUM' | 'HIGH';
export type OutcomeStatus =
  | 'PENDING'
  | 'HIT'
  | 'MISSED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'CLOSED_EARLY'
  | 'BREAKEVEN';
export type OutcomeSource = 'LIVE' | 'DEMO';
export type PredictionEngine = 'RULE_BASED' | 'DEEPSEEK';

export interface PredictionOutcome {
  status: OutcomeStatus;
  resolvedPrice: number | null;
  movementPips: number | null;
  evaluatedAt: string | null;
  source: OutcomeSource;
  note: string | null;
  /** Why it ended without a position or was cancelled. */
  reasonCode: ReasonCode | null;
  /** The engine's own entry (for slippage), once settled. */
  fillPrice: number | null;
  filledAt: string | null;
}

/**
 * Machine-readable reasons, so stand-asides and non-trades can be counted.
 * Stand-aside (on a Neutral call) and no-position (on an outcome) share one
 * list so the UI has one set of labels.
 */
export type ReasonCode =
  // Stand-asides: why no trade was published.
  | 'CONTEXT_NEUTRAL'
  | 'CONTEXT_SPLIT'
  | 'CHOPPY'
  | 'EXTREME_VOLATILITY'
  | 'DUPLICATE_SETUP'
  | 'H1_NOT_ALIGNED'
  | 'H1_AGAINST'
  | 'STRICT_WINDOW'
  | 'H1_NOT_REALIGNED'
  | 'STOP_TOO_WIDE'
  | 'NO_ZONE'
  | 'NO_ROOM'
  | 'USD_EXPOSURE'
  | 'DAILY_LOSS_LIMIT'
  | 'WIDE_SPREAD'
  | 'MODEL_DOWNGRADE'
  // No position / cancelled: why a published trade never became one.
  | 'NO_TOUCH'
  | 'NO_CONFIRMATION'
  | 'CONFIRMATION_EXPIRED'
  | 'NEWS_BLACKOUT'
  | 'STOP_BEFORE_ENTRY'
  | 'MOVED_AWAY'
  | 'H1_INVALIDATION'
  | 'CONTEXT_FLIP'
  | 'H1_TURNED';

export const REASON_LABEL: Record<ReasonCode, string> = {
  CONTEXT_NEUTRAL: 'Daily/H4 context neutral',
  CONTEXT_SPLIT: 'Daily and H4 disagree',
  CHOPPY: 'Choppy market',
  EXTREME_VOLATILITY: 'Extreme volatility',
  DUPLICATE_SETUP: 'Same setup already published',
  H1_NOT_ALIGNED: 'H1 not aligned yet',
  H1_AGAINST: 'H1 against the context',
  STRICT_WINDOW: 'Asia: not fully aligned',
  H1_NOT_REALIGNED: 'H1 not realigned after a stop',
  STOP_TOO_WIDE: 'Stop too wide for 1:2',
  NO_ZONE: 'No zone within reach',
  NO_ROOM: 'Target has no room',
  USD_EXPOSURE: 'USD exposure conflict',
  DAILY_LOSS_LIMIT: 'Daily loss limit',
  WIDE_SPREAD: 'Spread abnormally wide',
  MODEL_DOWNGRADE: 'Model review stood aside',
  NO_TOUCH: 'Price never reached the zone',
  NO_CONFIRMATION: 'No M15 confirmation',
  CONFIRMATION_EXPIRED: 'Confirmation expired',
  NEWS_BLACKOUT: 'Entry blocked by news',
  STOP_BEFORE_ENTRY: 'Stop traded before entry',
  MOVED_AWAY: 'Moved away without entry',
  H1_INVALIDATION: 'H1 closed beyond the stop',
  CONTEXT_FLIP: 'Daily/H4 context flipped',
  H1_TURNED: 'H1 turned against',
};

/**
 * Where a signal is in its life: waiting for price to reach the zone, in
 * the zone waiting for the M15 confirmation, entered, TP1/TP2 booked, closed
 * — or void (the setup died before an entry).
 */
export type LifecycleStage =
  | 'STAND_ASIDE'
  | 'WAITING_FOR_ZONE'
  | 'IN_ZONE'
  | 'ENTERED'
  | 'TP1'
  | 'TP2'
  | 'CLOSED'
  | 'VOID';

export interface TimeframeVote {
  timeframe: string;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  score: number;
}

/** Where an open signal stands right now, replayed from the newest M15 candles. */
export interface LiveProgress {
  /**
   * target: closed in profit (TP3, or the trailed stop after TP1/TP2) ·
   * stopped: the original stop.
   */
  state: 'neutral' | 'waiting' | 'running' | 'target' | 'stopped';
  filledAt: string | null;
  closedAt: string | null;
  /**
   * Signed pips for the whole position from the fill price (exit once
   * decided). With three targets it blends the thirds already booked.
   */
  pips: number | null;
  /** −100 (at the stop) … +100 (at the final target). */
  progress: number | null;
  lastPrice: number | null;
  /** End of the newest candle the replay used. */
  asOf: string | null;
  /** Targets reached so far (0–3). */
  tpHits: number;
  tp1At: string | null;
  tp2At: string | null;
  /** Where the stop is now: original → entry after TP1 → TP1 after TP2. */
  stopNow: number | null;
  stage: LifecycleStage;
  /** First candle in the entry zone. */
  touchedAt: string | null;
  /** The fill: confirming close (M15_CLOSE) or zone midpoint (TOUCH). */
  fillPrice: number | null;
  /** Set once the setup died before an entry. */
  voidReason: ReasonCode | null;
  /** A confirmation that would have filled inside a news window. */
  newsBlockedAt: string | null;
  /** Times a touch went stale without a confirmation. */
  expiredTouches: number;
}

/** A scheduled high-impact release that can move a signal's pair. */
export interface NewsRisk {
  title: string;
  currency: string;
  at: string;
  impact: Impact;
}

/**
 * TOUCH: filled at the zone midpoint as soon as price trades into the zone.
 * M15_CLOSE: after price trades into the zone, the first candle that closes
 * in the trade direction (and has not run beyond the zone) fills at its
 * close; if the stop trades first, there is no entry.
 */
export type EntryTrigger = 'TOUCH' | 'M15_CLOSE';

export interface Prediction {
  id: string;
  pairCode: PairCode;
  windowKey: string;
  direction: Direction;
  engine: PredictionEngine;
  modelName: string | null;
  confidence: number;
  entryLow: number;
  entryHigh: number;
  targetPrice: number;
  /** TP1 (+1R). Null on older single-target signals and stand-asides. */
  target1Price: number | null;
  /** TP3 (+1R beyond TP2). Null on older single-target signals and stand-asides. */
  target3Price: number | null;
  invalidationPrice: number;
  rationale: string;
  factors: string[];
  session: string;
  /** Day-trader session playbook (killzone, entry, invalidation, stand-aside). */
  playbook: string | null;
  /** Per-timeframe votes, monthly → down. */
  timeframeBias: TimeframeVote[] | null;
  /** How the entry fills (see EntryTrigger); TOUCH on older signals. */
  entryTrigger: EntryTrigger;
  /** High-impact news windows (ms) in which no entry fills (M15_CLOSE only). */
  blackouts: { from: number; to: number; title: string }[];
  /** Why a Neutral call stood aside. */
  reasonCode: ReasonCode | null;
  /** Rule version this was built with ("2026.10.3 · 3f9a1c22b0"), null on older rows. */
  strategy: { version: string; fingerprint: string } | null;
  stopPips: number | null;
  targetPips: number | null;
  riskReward: number | null;
  atrPips: number | null;
  validFrom: string;
  expiresAt: string;
  createdAt: string;
  outcome: PredictionOutcome | null;
  /** Only on currently active signals in the dashboard. */
  live?: LiveProgress | null;
  /** High-impact releases for the pair's currencies around this signal. */
  news?: NewsRisk[];
  /** "Hold" call: id of the still-open earlier signal this window manages. */
  continuesId: string | null;
  /**
   * Set when this earlier trade is shown as the pair's current signal because
   * the latest window's analysis carried it (no new signal was published).
   */
  carried?: {
    /** True: the analysis agreed; false: it was neutral (manage on own levels). */
    reconfirmed: boolean;
    /** Window that carried it, e.g. "London". */
    window: string;
    at: string;
  } | null;
}

export interface MarketEvent {
  id: string;
  currency: string;
  title: string;
  eventDate: string;
  impact: Impact;
  forecast: string | null;
  previousValue: string | null;
}

export type WeeklyBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface WeeklyScenario {
  trigger: string;
  target: number;
}

export interface WeeklyOutlook {
  id: string;
  weekKey: string;
  pairCode: PairCode;
  bias: WeeklyBias;
  confidence: number;
  headline: string;
  narrative: string;
  supports: number[];
  resistances: number[];
  scenarios: {
    bull: WeeklyScenario;
    base: WeeklyScenario;
    bear: WeeklyScenario;
  };
  catalysts: string[];
  tradingPlan: string;
  engine: PredictionEngine;
  modelName: string | null;
  weekStart: string;
  weekEnd: string;
  createdAt: string;
}

export interface TickerPrice {
  pairCode: PairCode;
  price: number | null;
  changePercent: number | null;
  /** Start time of the candle the price comes from. */
  asOf: string | null;
}

export interface DashboardData {
  generatedAt: string;
  cadence: string;
  marketStatus: 'OPEN' | 'CLOSED';
  currentSession: string;
  killzoneLabel: string | null;
  playbookHint: string | null;
  predictions: Prediction[];
  /** Earlier signals that triggered and are still running past their window. */
  openTrades: Prediction[];
  history: Prediction[];
  events: MarketEvent[];
  prices: TickerPrice[];
  weeklyOutlook: WeeklyOutlook[];
  stats: {
    hitRate: number;
    totalSignals: number;
    avgConfidence: number;
    nextRefresh: string;
  };
  /** Whether the live market providers are enabled in the backend configuration. */
  liveDataEnabled: boolean;
  /** Whether the backend has any real market content to display. */
  dataAvailable: boolean;
}

export function getSession(date: Date) {
  const hour = date.getUTCHours();
  if (hour >= 0 && hour < 8) return 'Tokyo';
  if (hour >= 8 && hour < 13) return 'London';
  if (hour >= 13 && hour < 17) return 'London / New York';
  if (hour >= 17 && hour < 22) return 'New York';
  return 'Asia pre-open';
}

/**
 * A dashboard shape with no content. Returned when the live market providers
 * are disabled or returned nothing, so the UI can render honest empty states
 * instead of simulated data.
 */
export function createEmptyDashboard(date = new Date()): DashboardData {
  const nextRefresh = nextWindowStart(date);
  return {
    generatedAt: date.toISOString(),
    cadence: 'Asia, London and New York windows',
    marketStatus: 'OPEN',
    currentSession: getSession(date),
    killzoneLabel: null,
    playbookHint: null,
    predictions: [],
    openTrades: [],
    history: [],
    events: [],
    prices: [],
    weeklyOutlook: [],
    stats: {
      hitRate: 0,
      totalSignals: 0,
      avgConfidence: 0,
      nextRefresh: nextRefresh.toISOString(),
    },
    liveDataEnabled: false,
    dataAvailable: false,
  };
}
