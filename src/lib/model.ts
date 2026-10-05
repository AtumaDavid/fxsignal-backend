export type PairCode = 'EUR/USD' | 'USD/JPY';
export type Direction = 'LONG' | 'SHORT' | 'NEUTRAL';
export type Impact = 'LOW' | 'MEDIUM' | 'HIGH';
export type OutcomeStatus = 'PENDING' | 'HIT' | 'MISSED' | 'EXPIRED';
export type OutcomeSource = 'LIVE' | 'DEMO';
export type PredictionEngine = 'RULE_BASED' | 'DEEPSEEK';

export interface PredictionOutcome {
  status: OutcomeStatus;
  resolvedPrice: number | null;
  movementPips: number | null;
  evaluatedAt: string | null;
  source: OutcomeSource;
  note: string | null;
}

export interface TimeframeVote {
  timeframe: string;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  score: number;
}

/** Where an open signal stands right now, replayed from the newest M15 candles. */
export interface LiveProgress {
  state: 'neutral' | 'waiting' | 'running' | 'target' | 'stopped';
  filledAt: string | null;
  closedAt: string | null;
  /** Signed pips from the zone midpoint (exit price once decided). */
  pips: number | null;
  /** −100 (at the stop) … +100 (at the target). */
  progress: number | null;
  lastPrice: number | null;
  /** End of the newest candle the replay used. */
  asOf: string | null;
}

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
  invalidationPrice: number;
  rationale: string;
  factors: string[];
  session: string;
  /** Day-trader session playbook (killzone, entry, invalidation, stand-aside). */
  playbook: string | null;
  /** Per-timeframe votes, monthly → down. */
  timeframeBias: TimeframeVote[] | null;
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

export function nextSixHourWindow(date: Date) {
  const next = new Date(date);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(Math.ceil(next.getUTCHours() / 6) * 6);
  if (next <= date) next.setUTCHours(next.getUTCHours() + 6);
  return next;
}

export function windowKeyFor(date: Date) {
  return String(Math.floor(date.getTime() / (6 * 60 * 60 * 1000)));
}

/**
 * A dashboard shape with no content. Returned when the live market providers
 * are disabled or returned nothing, so the UI can render honest empty states
 * instead of simulated data.
 */
export function createEmptyDashboard(date = new Date()): DashboardData {
  const nextRefresh = nextSixHourWindow(date);
  return {
    generatedAt: date.toISOString(),
    cadence: 'Every 6 hours',
    marketStatus: 'OPEN',
    currentSession: getSession(date),
    killzoneLabel: null,
    playbookHint: null,
    predictions: [],
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
