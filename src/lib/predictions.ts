import {
  Prisma,
  type Direction as PrismaDirection,
  type OutcomeSource as PrismaOutcomeSource,
  type OutcomeStatus as PrismaOutcomeStatus,
  type PredictionEngine as PrismaPredictionEngine,
  type WeeklyBias as PrismaWeeklyBias,
} from '@prisma/client';
import { prisma } from './prisma.js';
import {
  createEmptyDashboard,
  getSession,
  nextSixHourWindow,
  windowKeyFor,
  type DashboardData,
  type Direction,
  type LiveProgress,
  type MarketEvent,
  type PairCode,
  type Prediction,
  type TickerPrice,
  type TimeframeVote,
  type WeeklyBias,
  type WeeklyOutlook,
} from './model.js';
import {
  isForexOpen,
  nextMarketClose,
  nextMarketOpen,
  PAIRS,
  pipSize,
  roundToPip,
  sessionInfo,
  toPips,
  tradingWeekAnchor,
  weekBounds,
  weekKeyFor,
} from './market.js';
import {
  analyzeTimeframe,
  buildDayTradeLevels,
  confluence,
  enforceMinRewardRisk,
  intradayConfluence,
  type Candle,
  type Confluence,
  type Timeframe,
  type TimeframeView,
} from './technical.js';
import {
  normalizeLevels,
  requestIntradayAnalysis,
  requestWeeklyAnalysis,
  type IntradayAiResult,
  type MtfPairContext,
  type WeeklyAiOutlook,
} from './ai.js';
import {
  aiAnalysisEnabled,
  candleTime,
  fetchLiveEvents,
  fetchMultiTimeframe,
  fetchTimeframeCandles,
  fetchWeekEvents,
  liveDataEnabled,
  type LiveMarketEvent,
  type MultiTimeframe,
} from './liveData.js';
import { peekStale } from './rateCache.js';

const pairs: PairCode[] = [...PAIRS];

// Free-tier friendly: provider calls are rate-limited, so back off between AI
// generation attempts even when they fail (a failed attempt is retried by the
// background scheduler, not by every web refresh).
const AI_GENERATION_COOLDOWN_MS = 15 * 60_000;
let lastAiGenerationAttempt = 0;
const OUTLOOK_GENERATION_COOLDOWN_MS = 60 * 60_000;
let lastOutlookGenerationAttempt = 0;

const predictionWithOutcome = Prisma.validator<Prisma.PredictionDefaultArgs>()({
  include: { outcome: true },
});
type DbPrediction = Prisma.PredictionGetPayload<typeof predictionWithOutcome>;

function outcomeFromRow(row: DbPrediction['outcome']): Prediction['outcome'] {
  if (!row) return null;
  return {
    status: row.status as 'PENDING' | 'HIT' | 'MISSED' | 'EXPIRED',
    resolvedPrice:
      row.resolvedPrice === null ? null : Number(row.resolvedPrice),
    movementPips: row.movementPips === null ? null : Number(row.movementPips),
    evaluatedAt: row.evaluatedAt?.toISOString() ?? null,
    source: row.source as 'LIVE' | 'DEMO',
    note: row.note,
  };
}

function votesFromJson(value: unknown): TimeframeVote[] | null {
  if (!Array.isArray(value)) return null;
  const votes = value.filter(
    (v): v is TimeframeVote =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as TimeframeVote).timeframe === 'string'
  );
  return votes.length > 0 ? votes : null;
}

export function fromRow(row: DbPrediction): Prediction {
  return {
    id: String(row.id),
    pairCode: row.pairCode as PairCode,
    windowKey: row.windowKey,
    direction: row.direction as Direction,
    engine: row.engine as Prediction['engine'],
    modelName: row.modelName,
    confidence: row.confidence,
    entryLow: Number(row.entryLow),
    entryHigh: Number(row.entryHigh),
    targetPrice: Number(row.targetPrice),
    invalidationPrice: Number(row.invalidationPrice),
    rationale: row.rationale,
    factors: Array.isArray(row.factors)
      ? row.factors.filter(
          (factor): factor is string => typeof factor === 'string'
        )
      : [],
    session: row.session,
    playbook: row.playbook ?? null,
    timeframeBias: votesFromJson(row.timeframeBias),
    stopPips: row.stopPips === null ? null : Number(row.stopPips),
    targetPips: row.targetPips === null ? null : Number(row.targetPips),
    riskReward: row.riskReward === null ? null : Number(row.riskReward),
    atrPips: row.atrPips === null ? null : Number(row.atrPips),
    validFrom: row.validFrom.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    outcome: outcomeFromRow(row.outcome),
  };
}

function eventFromRow(row: {
  id: number;
  currency: string;
  title: string;
  eventDate: Date;
  impact: MarketEvent['impact'];
  forecast: string | null;
  previousValue: string | null;
}): MarketEvent {
  return {
    id: String(row.id),
    currency: row.currency,
    title: row.title,
    eventDate: row.eventDate.toISOString(),
    impact: row.impact,
    forecast: row.forecast,
    previousValue: row.previousValue,
  };
}

function outlookFromRow(row: {
  id: number;
  weekKey: string;
  pairCode: string;
  bias: PrismaWeeklyBias;
  confidence: number;
  headline: string;
  narrative: string;
  supports: unknown;
  resistances: unknown;
  scenarios: unknown;
  catalysts: unknown;
  tradingPlan: string;
  engine: PrismaPredictionEngine;
  modelName: string | null;
  weekStart: Date;
  weekEnd: Date;
  createdAt: Date;
}): WeeklyOutlook {
  const numArray = (v: unknown): number[] =>
    Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : [];
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  const s = row.scenarios as {
    bull?: { trigger?: string; target?: number };
    base?: { trigger?: string; target?: number };
    bear?: { trigger?: string; target?: number };
  };
  return {
    id: String(row.id),
    weekKey: row.weekKey,
    pairCode: row.pairCode as PairCode,
    bias: row.bias as WeeklyBias,
    confidence: row.confidence,
    headline: row.headline,
    narrative: row.narrative,
    supports: numArray(row.supports),
    resistances: numArray(row.resistances),
    scenarios: {
      bull: { trigger: s?.bull?.trigger ?? '', target: s?.bull?.target ?? 0 },
      base: { trigger: s?.base?.trigger ?? '', target: s?.base?.target ?? 0 },
      bear: { trigger: s?.bear?.trigger ?? '', target: s?.bear?.target ?? 0 },
    },
    catalysts: strArray(row.catalysts),
    tradingPlan: row.tradingPlan,
    engine: row.engine as WeeklyOutlook['engine'],
    modelName: row.modelName,
    weekStart: row.weekStart.toISOString(),
    weekEnd: row.weekEnd.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

async function activePrediction(pairCode: PairCode, now: Date) {
  return prisma.prediction.findFirst({
    where: {
      pairCode,
      validFrom: { lte: now },
      expiresAt: { gt: now },
    },
    include: { outcome: true },
    orderBy: { createdAt: 'desc' },
  });
}

// ---- Deterministic (rule-based) day-trader core ------------------------------
// Always runs on real indicators. The AI refines this when available; when the
// AI is disabled or fails, these signals still publish with RULE_BASED.

interface DeterministicSignal {
  pairCode: PairCode;
  direction: Direction;
  confidence: number;
  entryLow: number;
  entryHigh: number;
  targetPrice: number;
  invalidationPrice: number;
  rationale: string;
  factors: string[];
  playbook: string;
  votes: TimeframeVote[];
  stopPips: number;
  targetPips: number;
  riskReward: number;
  atrPips: number | null;
  price: number;
  confluence: Confluence;
  /** Inputs to rebuild engine levels if the model review moves them badly. */
  levelInputs: {
    atr: number | null;
    swingHigh: number | null;
    swingLow: number | null;
  };
}

/** Engine version recorded on rule-built signals. */
const ENGINE_MODEL = 'ctx-h1-exec-v3';

/** Intraday model: Daily + H4 context, H1 execution, M15 confirmation. */
export const INTRADAY_TIMEFRAMES: Timeframe[] = ['DAILY', 'H4', 'H1', 'M15'];
/** H1 bars that define the execution structure (stop placement). */
const H1_STRUCTURE_BARS = 10;

function catalystPenalty(events: LiveMarketEvent[], now: Date): number {
  const windowEnd = now.getTime() + 6 * 60 * 60 * 1000;
  let penalty = 0;
  for (const event of events) {
    const t = event.eventDate.getTime();
    if (t < now.getTime() - 30 * 60 * 1000 || t > windowEnd) continue;
    if (event.impact === 'HIGH') penalty += 10;
    else if (event.impact === 'MEDIUM') penalty += 3;
  }
  return Math.min(20, penalty);
}

export function buildDeterministicSignal(
  pair: PairCode,
  mtf: MultiTimeframe,
  events: LiveMarketEvent[],
  session: string,
  killzoneHint: string,
  now: Date
): DeterministicSignal | null {
  const views: TimeframeView[] = [];
  for (const tf of INTRADAY_TIMEFRAMES) {
    const candles = mtf[tf];
    if (!candles || candles.length < 5) continue;
    const view = analyzeTimeframe(pair, tf, candles);
    if (view) views.push(view);
  }
  const h1 = views.find((v) => v.timeframe === 'H1');
  const hasContext = views.some(
    (v) => v.timeframe === 'DAILY' || v.timeframe === 'H4'
  );
  if (!h1 || !hasContext) return null;

  const penalty = catalystPenalty(events, now);
  const conf = intradayConfluence(views, penalty);
  if (!conf) return null;

  // Price from the confirmation timeframe (freshest), levels from H1.
  const price = views.find((v) => v.timeframe === 'M15')?.price ?? h1.price;
  const recentH1 = (mtf.H1 ?? []).slice(0, H1_STRUCTURE_BARS); // newest-first
  const swingHigh = recentH1.length
    ? Math.max(...recentH1.map((c) => c.high))
    : h1.swingHigh;
  const swingLow = recentH1.length
    ? Math.min(...recentH1.map((c) => c.low))
    : h1.swingLow;

  let direction = conf.direction;
  let levels = buildDayTradeLevels(
    pair,
    direction,
    price,
    h1.atr,
    swingHigh,
    swingLow
  );
  const notes = [...conf.notes];
  if (!levels.tradeable) {
    // Structure too wide for 1:2 — say so and stand aside instead of
    // publishing a worse ratio.
    notes.unshift(
      levels.reason ?? 'Setup does not offer 1:2 — standing aside.'
    );
    direction = 'NEUTRAL';
    levels = buildDayTradeLevels(
      pair,
      direction,
      price,
      h1.atr,
      swingHigh,
      swingLow
    );
  }
  const guarded = normalizeLevels({
    pairCode: pair,
    direction,
    entryLow: levels.entryLow,
    entryHigh: levels.entryHigh,
    targetPrice: levels.targetPrice,
    invalidationPrice: levels.invalidationPrice,
  });

  const contextWord =
    conf.score >= 15 ? 'bullish' : conf.score <= -15 ? 'bearish' : 'mixed';
  const voteWords = conf.votes
    .map(
      (v) =>
        `${v.timeframe === 'DAILY' ? 'daily' : v.timeframe} ${v.bias.toLowerCase()} (${v.score})`
    )
    .join(', ');
  const risk = riskFor(guarded);
  const rationale =
    direction === 'NEUTRAL'
      ? `No execution this window. Context (daily + H4) is ${contextWord}; ${notes[0] ?? ''} Votes: ${voteWords}.`
      : `Daily + H4 context is ${contextWord}; H1 is the execution timeframe and M15 the confirmation. ` +
        `Votes: ${voteWords}. Stop beyond the last ${H1_STRUCTURE_BARS} H1 bars' structure ` +
        `(${risk.stopPips} pips) for a ${risk.targetPips}-pip target (${risk.riskReward}R). ${session} session — ${killzoneHint}`;

  const factors = [
    ...notes.slice(0, 4),
    ...(direction === 'NEUTRAL'
      ? []
      : [
          `Risk ${risk.stopPips}p / reward ${risk.targetPips}p (${risk.riskReward}R)`,
        ]),
  ].slice(0, 5);

  const side = direction === 'LONG' ? 'long' : 'short';
  const playbook =
    direction === 'NEUTRAL'
      ? `${session}: stand aside. Re-check when H1 realigns with the daily/H4 context, or at the next window.`
      : `${session} plan: ${side} only, executed on H1 inside ${guarded.entryLow}–${guarded.entryHigh}. ` +
        `Before entering, wait for an M15 candle to close in the ${side} direction inside the zone. ` +
        `Invalidate ${direction === 'LONG' ? 'below' : 'above'} ${guarded.invalidationPrice} (${risk.stopPips}p); ` +
        `target ${guarded.targetPrice} (${risk.targetPips}p, ${risk.riskReward}R). Skip it if a high-impact release lands before the trigger.`;

  return {
    pairCode: pair,
    direction,
    confidence:
      direction === 'NEUTRAL' ? Math.min(conf.confidence, 45) : conf.confidence,
    entryLow: guarded.entryLow,
    entryHigh: guarded.entryHigh,
    targetPrice: guarded.targetPrice,
    invalidationPrice: guarded.invalidationPrice,
    rationale: rationale.slice(0, 600),
    factors,
    playbook: playbook.slice(0, 600),
    votes: conf.votes,
    stopPips: risk.stopPips,
    targetPips: risk.targetPips,
    riskReward: risk.riskReward,
    atrPips: levels.atrPips,
    price,
    confluence: { ...conf, direction, notes },
    levelInputs: { atr: h1.atr, swingHigh, swingLow },
  };
}

/**
 * A signal covers the rest of its six-hour window (00/06/12/18 UTC) and never
 * outlives the Friday close. Expiring one window later used to leave each
 * signal active for up to 12 hours, so the next window never generated its
 * own signal and the advertised 6-hour cadence silently became 12.
 */
export function signalWindowEnd(now: Date): Date {
  const windowEnd = nextSixHourWindow(now);
  const close = nextMarketClose(now);
  return windowEnd < close ? windowEnd : close;
}

/**
 * Stop / target distances and reward:risk measured from the middle of the
 * entry zone for the levels that are actually published. The AI may move the
 * levels, so these must be derived from the final numbers, not the
 * deterministic draft.
 */
export function riskFor(levels: {
  pairCode: PairCode;
  entryLow: number;
  entryHigh: number;
  targetPrice: number;
  invalidationPrice: number;
}) {
  const mid = (levels.entryLow + levels.entryHigh) / 2;
  const stopPips = Number(
    toPips(levels.pairCode, mid - levels.invalidationPrice).toFixed(1)
  );
  const targetPips = Number(
    toPips(levels.pairCode, levels.targetPrice - mid).toFixed(1)
  );
  return {
    stopPips,
    targetPips,
    riskReward: stopPips > 0 ? Number((targetPips / stopPips).toFixed(2)) : 0,
  };
}

function toPrediction(
  signal: DeterministicSignal,
  now: Date,
  engine: 'RULE_BASED' | 'DEEPSEEK',
  modelName: string | null,
  ai?: IntradayAiResult
): Prediction {
  const expiresAt = signalWindowEnd(now);

  // The model review may keep the engine's direction or downgrade it to
  // NEUTRAL. It may not flip it, and it may not trade a window the engine
  // stood aside on (H1 against the context, or no room for 1:2).
  const aiUsable =
    ai &&
    signal.direction !== 'NEUTRAL' &&
    (ai.direction === signal.direction || ai.direction === 'NEUTRAL')
      ? ai
      : undefined;
  const direction = aiUsable?.direction ?? signal.direction;

  // Levels: the model's, if they still give at least 1:2 after the
  // guard-rails; otherwise the engine's (built for 2R by construction).
  const engineLevels = {
    pairCode: signal.pairCode,
    direction,
    entryLow: signal.entryLow,
    entryHigh: signal.entryHigh,
    targetPrice: signal.targetPrice,
    invalidationPrice: signal.invalidationPrice,
  };
  const modelLevels =
    aiUsable && direction !== 'NEUTRAL'
      ? enforceMinRewardRisk(
          normalizeLevels({
            pairCode: signal.pairCode,
            direction,
            entryLow: aiUsable.entryLow,
            entryHigh: aiUsable.entryHigh,
            targetPrice: aiUsable.targetPrice,
            invalidationPrice: aiUsable.invalidationPrice,
          })
        )
      : null;
  const { entryLow, entryHigh, targetPrice, invalidationPrice } =
    modelLevels ?? engineLevels;
  const risk = riskFor({
    pairCode: signal.pairCode,
    entryLow,
    entryHigh,
    targetPrice,
    invalidationPrice,
  });
  ai = aiUsable;
  return {
    id: '',
    pairCode: signal.pairCode,
    windowKey: windowKeyFor(now),
    direction,
    // Labelled by what actually shaped the published call.
    engine: aiUsable ? engine : 'RULE_BASED',
    modelName: aiUsable ? modelName : ENGINE_MODEL,
    confidence: ai
      ? Math.max(15, Math.min(92, ai.confidence))
      : signal.confidence,
    entryLow,
    entryHigh,
    targetPrice,
    invalidationPrice,
    rationale: (ai?.rationale ?? signal.rationale).slice(0, 600),
    factors: (ai?.factors?.length ? ai.factors : signal.factors).slice(0, 5),
    session: getSession(now),
    playbook: (ai?.playbook ?? signal.playbook).slice(0, 600),
    timeframeBias: signal.votes,
    stopPips: risk.stopPips,
    targetPips: risk.targetPips,
    riskReward: risk.riskReward,
    atrPips: signal.atrPips,
    validFrom: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
    outcome: {
      status: 'PENDING',
      resolvedPrice: null,
      movementPips: null,
      evaluatedAt: null,
      source: 'LIVE',
      note: 'Waiting for a live price evaluation.',
    },
  };
}

async function insertPrediction(prediction: Prediction) {
  return prisma.prediction.create({
    data: {
      pairCode: prediction.pairCode,
      windowKey: prediction.windowKey,
      direction: prediction.direction as PrismaDirection,
      engine: prediction.engine as PrismaPredictionEngine,
      modelName: prediction.modelName,
      confidence: prediction.confidence,
      entryLow: prediction.entryLow,
      entryHigh: prediction.entryHigh,
      targetPrice: prediction.targetPrice,
      invalidationPrice: prediction.invalidationPrice,
      rationale: prediction.rationale,
      factors: prediction.factors,
      session: prediction.session,
      playbook: prediction.playbook,
      timeframeBias:
        (prediction.timeframeBias as unknown as Prisma.InputJsonValue) ??
        Prisma.JsonNull,
      stopPips: prediction.stopPips,
      targetPips: prediction.targetPips,
      riskReward: prediction.riskReward,
      atrPips: prediction.atrPips,
      validFrom: prediction.validFrom,
      expiresAt: prediction.expiresAt,
      outcome: {
        create: {
          source: 'LIVE' as PrismaOutcomeSource,
          status: 'PENDING' as PrismaOutcomeStatus,
          note: 'Waiting for a live price evaluation.',
        },
      },
    },
    include: { outcome: true },
  });
}

async function updatePredictionWithSignal(id: number, prediction: Prediction) {
  return prisma.prediction.update({
    where: { id },
    data: {
      direction: prediction.direction as PrismaDirection,
      engine: prediction.engine as PrismaPredictionEngine,
      modelName: prediction.modelName,
      confidence: prediction.confidence,
      entryLow: prediction.entryLow,
      entryHigh: prediction.entryHigh,
      targetPrice: prediction.targetPrice,
      invalidationPrice: prediction.invalidationPrice,
      rationale: prediction.rationale,
      factors: prediction.factors,
      session: prediction.session,
      playbook: prediction.playbook,
      timeframeBias:
        (prediction.timeframeBias as unknown as Prisma.InputJsonValue) ??
        Prisma.JsonNull,
      stopPips: prediction.stopPips,
      targetPips: prediction.targetPips,
      riskReward: prediction.riskReward,
      atrPips: prediction.atrPips,
      outcome: {
        upsert: {
          create: {
            source: 'LIVE' as PrismaOutcomeSource,
            status: 'PENDING' as PrismaOutcomeStatus,
            note: 'Waiting for a live price evaluation.',
          },
          update: {
            source: 'LIVE' as PrismaOutcomeSource,
            status: 'PENDING' as PrismaOutcomeStatus,
            note: 'Waiting for a live price evaluation.',
          },
        },
      },
    },
    include: { outcome: true },
  });
}

/**
 * Builds the current-window signals from multi-timeframe market data.
 * Deterministic indicators always run; DeepSeek refines when configured.
 */
async function liveIntradayPredictions(now: Date): Promise<Prediction[]> {
  const info = sessionInfo(now);
  const events = await fetchLiveEvents(now).catch((error) => {
    console.warn(
      'Trading Economics calendar unavailable for signal context.',
      error instanceof Error ? error.message : error
    );
    return [] as LiveMarketEvent[];
  });

  // One MTF pull per pair; a pair that fails entirely is skipped honestly.
  const contexts: {
    pair: PairCode;
    signal: DeterministicSignal;
    mtfContext: MtfPairContext;
  }[] = [];
  for (const pair of pairs) {
    try {
      // Only the four intraday timeframes: monthly/weekly are not needed here
      // (and skipping them saves provider credits).
      const mtf = await fetchMultiTimeframe(pair, INTRADAY_TIMEFRAMES);
      const signal = buildDeterministicSignal(
        pair,
        mtf,
        events,
        info.session,
        info.playbookHint,
        now
      );
      if (!signal) {
        console.warn(`Insufficient MTF context for ${pair}; skipping.`);
        continue;
      }
      contexts.push({
        pair,
        signal,
        mtfContext: {
          pairCode: pair,
          price: signal.price,
          confluence: signal.confluence,
          session: info.session,
          killzoneHint: info.playbookHint,
        },
      });
    } catch (error) {
      console.warn(
        `MTF fetch failed for ${pair}.`,
        error instanceof Error ? error.message : error
      );
    }
  }
  if (contexts.length === 0)
    throw new Error('No multi-timeframe data available.');

  let aiResults: IntradayAiResult[] = [];
  if (aiAnalysisEnabled()) {
    try {
      aiResults = await requestIntradayAnalysis(
        contexts.map((c) => c.mtfContext),
        events
      );
    } catch (error) {
      console.warn(
        'AI refinement unavailable; publishing deterministic signals.',
        error instanceof Error ? error.message : error
      );
    }
  }

  const modelName = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  return contexts.map(({ pair, signal }) => {
    const ai = aiResults.find((r) => r.pairCode === pair);
    return toPrediction(
      signal,
      now,
      ai ? 'DEEPSEEK' : 'RULE_BASED',
      ai ? modelName : ENGINE_MODEL,
      ai
    );
  });
}

interface Settlement {
  status: PrismaOutcomeStatus;
  resolvedPrice: number | null;
  movementPips: number | null;
  note: string;
}

const CANDLE_MS: Partial<Record<Timeframe, number>> = {
  M15: 15 * 60_000,
  H1: 60 * 60_000,
};

interface LevelRow {
  pairCode: string;
  direction: string;
  entryLow: number;
  entryHigh: number;
  targetPrice: number;
  invalidationPrice: number;
}

export interface PathReplay {
  /** neutral: not a trade · waiting: entry not reached · running: filled, open · target / stopped: decided. */
  state: 'neutral' | 'waiting' | 'running' | 'target' | 'stopped';
  /** Start of the candle where the entry zone first traded (ms). */
  filledAt: number | null;
  /** Start of the candle where target or invalidation traded (ms). */
  closedAt: number | null;
  lastClose: number | null;
  /** Signed pips from the zone midpoint: at the exit when decided, at the last close while running. */
  pips: number | null;
}

/**
 * Replays a signal's levels against candles (oldest first), the way a trader
 * would have experienced them:
 * - the position only exists once price trades into the entry zone (filled at
 *   the zone midpoint);
 * - after the fill, whichever of stop or target is touched first decides the
 *   result; when both fall inside one candle the stop is assumed first;
 * - NEUTRAL calls are a stand-aside, not a trade.
 * Used both to settle expired signals and to show live progress, so the two
 * can never disagree.
 */
export function replayPath(row: LevelRow, candles: Candle[]): PathReplay {
  const pair = row.pairCode as PairCode;
  const lastClose =
    candles.length > 0 ? candles[candles.length - 1].close : null;
  const base = { filledAt: null, closedAt: null, lastClose, pips: null };
  if (row.direction === 'NEUTRAL') return { ...base, state: 'neutral' };

  const isLong = row.direction === 'LONG';
  const fill = (row.entryLow + row.entryHigh) / 2;
  const signed = (price: number) =>
    Number(((isLong ? price - fill : fill - price) / pipSize(pair)).toFixed(1));

  let filledAt: number | null = null;
  for (const candle of candles) {
    if (filledAt === null) {
      if (candle.low > row.entryHigh || candle.high < row.entryLow) continue;
      filledAt = candleTime(candle);
    }
    const stopHit = isLong
      ? candle.low <= row.invalidationPrice
      : candle.high >= row.invalidationPrice;
    const targetHit = isLong
      ? candle.high >= row.targetPrice
      : candle.low <= row.targetPrice;
    if (stopHit || targetHit) {
      const exit = stopHit ? row.invalidationPrice : row.targetPrice;
      return {
        state: stopHit ? 'stopped' : 'target',
        filledAt,
        closedAt: candleTime(candle),
        lastClose,
        pips: signed(exit),
      };
    }
  }
  if (filledAt === null) return { ...base, state: 'waiting' };
  return {
    state: 'running',
    filledAt,
    closedAt: null,
    lastClose,
    pips: lastClose === null ? null : signed(lastClose),
  };
}

/**
 * Live state of an active signal from the cached M15 candles since it was
 * published. Read-only: never calls the provider (maintenance keeps the M15
 * series fresh while a signal is open).
 */
async function liveProgress(p: Prediction): Promise<LiveProgress | null> {
  const cached = await peekStale<Candle[]>(
    `twelvedata:tf:${p.pairCode}:M15`
  ).catch(() => null);
  if (!cached || cached.length === 0) return null;
  const span = 15 * 60_000;
  const from = new Date(p.validFrom).getTime();
  const to = new Date(p.expiresAt).getTime();
  const candles = [...cached]
    .sort((a, b) => candleTime(a) - candleTime(b))
    .filter((c) => candleTime(c) + span > from && candleTime(c) < to);
  if (candles.length === 0) return null;
  const path = replayPath(p, candles);
  const progress =
    path.pips === null
      ? null
      : path.pips >= 0
        ? p.targetPips
          ? Math.min(100, (path.pips / p.targetPips) * 100)
          : null
        : p.stopPips
          ? Math.max(-100, (path.pips / p.stopPips) * 100)
          : null;
  return {
    state: path.state,
    filledAt: path.filledAt ? new Date(path.filledAt).toISOString() : null,
    closedAt: path.closedAt ? new Date(path.closedAt).toISOString() : null,
    pips: path.pips,
    progress: progress === null ? null : Math.round(progress),
    lastPrice: path.lastClose,
    asOf: new Date(
      candleTime(candles[candles.length - 1]) + span
    ).toISOString(),
  };
}

/** Final outcome for an expired signal from its window's candles. */
export function settleFromCandles(
  row: LevelRow,
  candles: Candle[]
): Settlement {
  const path = replayPath(row, candles);
  switch (path.state) {
    case 'neutral':
      return {
        status: 'EXPIRED',
        resolvedPrice: path.lastClose,
        movementPips: null,
        note: 'Neutral stance — a stand-aside window, not scored.',
      };
    case 'stopped':
      return {
        status: 'MISSED',
        resolvedPrice: row.invalidationPrice,
        movementPips: path.pips,
        note: 'Invalidation level traded before the target.',
      };
    case 'target':
      return {
        status: 'HIT',
        resolvedPrice: row.targetPrice,
        movementPips: path.pips,
        note: 'Target reached before the invalidation level.',
      };
    case 'waiting':
      return {
        status: 'EXPIRED',
        resolvedPrice: path.lastClose,
        movementPips: null,
        note: 'Price never traded into the entry zone — no position was taken.',
      };
    default:
      return {
        status: 'EXPIRED',
        resolvedPrice: path.lastClose,
        movementPips: path.pips,
        note: 'Neither target nor invalidation reached before expiry; marked to the last close.',
      };
  }
}

/** Candles (oldest first) that fall inside [from, to), or null if the series does not cover the window. */
function windowCandles(
  candles: Candle[],
  timeframe: Timeframe,
  from: Date,
  to: Date
): Candle[] | null {
  const span = CANDLE_MS[timeframe] ?? 60 * 60_000;
  const ordered = [...candles].sort((a, b) => candleTime(a) - candleTime(b));
  if (ordered.length === 0) return null;
  const first = candleTime(ordered[0]);
  const last = candleTime(ordered[ordered.length - 1]);
  // The series must start before the window and reach its final candle.
  if (first > from.getTime() || last + span < to.getTime()) return null;
  // Include the candle the signal was published in; it may have filled there.
  return ordered.filter((candle) => {
    const t = candleTime(candle);
    return t + span > from.getTime() && t < to.getTime();
  });
}

/** How long to wait for candles covering an expired window before giving up. */
const SETTLEMENT_GRACE_MS = 3 * 60 * 60_000;

/**
 * Settles expired signals from the M15 (or H1) price path of their window.
 * Signals whose window the price feed cannot cover — for example ones that
 * expired while the server was offline for longer than the H1 history — are
 * closed as unverifiable instead of being judged against a later price.
 */
export async function evaluateExpiredPredictions(now = new Date()) {
  if (!liveDataEnabled()) return;

  const pending = await prisma.prediction.findMany({
    where: {
      expiresAt: { lte: now },
      outcome: { is: { status: 'PENDING' } },
    },
    include: { outcome: true },
  });
  if (pending.length === 0) return;

  // One series per pair and timeframe for the whole batch (cached and
  // credit-budgeted), never one request per row.
  const series = new Map<string, Candle[]>();
  async function candlesFor(pair: PairCode, timeframe: Timeframe) {
    const key = `${pair}:${timeframe}`;
    if (!series.has(key)) {
      try {
        series.set(key, await fetchTimeframeCandles(pair, timeframe));
      } catch (error) {
        console.warn(
          `No ${timeframe} candles to settle ${pair}; its signals stay pending.`,
          error instanceof Error ? error.message : error
        );
        series.set(key, []);
      }
    }
    return series.get(key) ?? [];
  }

  for (const row of pending) {
    const pair = row.pairCode as PairCode;
    let path: Candle[] | null = null;
    for (const timeframe of ['M15', 'H1'] as const) {
      path = windowCandles(
        await candlesFor(pair, timeframe),
        timeframe,
        row.validFrom,
        row.expiresAt
      );
      if (path) break;
    }

    let result: Settlement;
    if (path) {
      result = settleFromCandles(
        {
          pairCode: row.pairCode,
          direction: row.direction,
          entryLow: Number(row.entryLow),
          entryHigh: Number(row.entryHigh),
          targetPrice: Number(row.targetPrice),
          invalidationPrice: Number(row.invalidationPrice),
        },
        path
      );
    } else if (now.getTime() - row.expiresAt.getTime() > SETTLEMENT_GRACE_MS) {
      result = {
        status: 'EXPIRED',
        resolvedPrice: null,
        movementPips: null,
        note: 'Not scored — no price data covering this window was available.',
      };
    } else {
      continue; // The newest candles are not published yet; retry next pass.
    }

    try {
      await prisma.predictionOutcome.update({
        where: { predictionId: row.id },
        data: {
          ...result,
          evaluatedAt: now,
          source: 'LIVE' as PrismaOutcomeSource,
        },
      });
    } catch (error) {
      console.warn(
        `Unable to store the outcome for prediction ${row.id}.`,
        error instanceof Error ? error.message : error
      );
    }
  }
}

/**
 * Returns the current signals for the tracked pairs, reading only from the
 * database. Never calls the live providers — generation is owned by the
 * background scheduler (`maintainMarketData`), so web refreshes are free.
 */
export async function getCurrentPredictions(
  now = new Date()
): Promise<Prediction[]> {
  const rows = await Promise.all(
    pairs.map((pair) => activePrediction(pair, now))
  );
  return (
    rows
      .filter((row): row is NonNullable<typeof row> => row !== null)
      // Guard against degenerate levels that may have been stored by an older
      // generation (tiny entry zones, targets inside the zone). Idempotent — once
      // stored signals are sane, this is a no-op.
      .map((row) => normalizeLevels(fromRow(row)))
  );
}

/**
 * Creates or refreshes the current-window signals from multi-timeframe
 * analysis. No-ops while the market is closed (weekends) — there is no
 * intraday edge to publish, and the weekend outlook owns that window.
 *
 * Free-tier friendly:
 * - once an active signal exists for the window, it is reused from the
 *   database and the providers are not called again until that signal expires;
 * - failed attempts back off for 15 minutes instead of hammering the providers.
 *   `force: true` (used by an explicit user retry) bypasses that cooldown.
 */
export async function getOrCreatePredictions(
  now = new Date(),
  options?: { force?: boolean }
): Promise<Prediction[]> {
  if (!liveDataEnabled()) return [];
  if (!isForexOpen(now)) return getCurrentPredictions(now);

  const activeRows = await Promise.all(
    pairs.map((pair) => activePrediction(pair, now))
  );
  const needsRefresh = activeRows.some((row) => !row);

  if (!needsRefresh) {
    return activeRows
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .map(fromRow);
  }

  const nowMs = now.getTime();
  if (
    !options?.force &&
    nowMs - lastAiGenerationAttempt < AI_GENERATION_COOLDOWN_MS
  ) {
    // Still cooling down from the last attempt; keep whatever is stored.
    return activeRows
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .map(fromRow);
  }
  lastAiGenerationAttempt = nowMs;

  let signals: Prediction[] = [];
  try {
    signals = await liveIntradayPredictions(now);
  } catch (error) {
    console.warn(
      'Intraday generation unavailable; keeping the stored signal.',
      error instanceof Error ? error.message : error
    );
    return activeRows
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .map(fromRow);
  }

  const result: Prediction[] = [];
  for (const [index, pair] of pairs.entries()) {
    const active = activeRows[index];
    const signal = signals.find((s) => s.pairCode === pair);
    if (!signal) {
      if (active) result.push(fromRow(active));
      continue;
    }
    try {
      const row = active
        ? await updatePredictionWithSignal(active.id, signal)
        : await insertPrediction(signal);
      result.push(fromRow(row as DbPrediction));
    } catch (error) {
      // Window race (unique pairCode+windowKey) — fall back to the stored row.
      console.warn(
        `Unable to store signal for ${pair}.`,
        error instanceof Error ? error.message : error
      );
      if (active) result.push(fromRow(active));
    }
  }
  return result;
}

export async function getHistory(
  limit = 50,
  now = new Date(),
  options?: {
    days?: number;
    session?: string;
    pair?: PairCode;
    /** Internal reads (performance) may exceed the 200-row page size. */
    maxRows?: number;
  }
) {
  // Read-only: expired-signal evaluation is owned by maintainMarketData().
  const days = options?.days ?? 30;
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.prediction.findMany({
    where: {
      expiresAt: { lte: now, gte: since },
      ...(options?.session ? { session: options.session } : {}),
      ...(options?.pair ? { pairCode: options.pair } : {}),
    },
    include: { outcome: true },
    orderBy: { validFrom: 'desc' },
    take: Math.min(Math.max(limit, 1), options?.maxRows ?? 200),
  });
  return rows.map(fromRow);
}

export async function getPairPrediction(pairCode: PairCode, now = new Date()) {
  const active = await activePrediction(pairCode, now);
  return active ? fromRow(active) : null;
}

// ---- Weekend weekly outlook (monthly → down) --------------------------------

const HTF_ORDER: Timeframe[] = ['MONTHLY', 'WEEKLY', 'DAILY', 'H4', 'H1'];

/** The week the outlook should cover: current week, or next week on weekends. */
export function targetWeek(now = new Date()): {
  weekKey: string;
  weekStart: Date;
  weekEnd: Date;
} {
  const anchor = tradingWeekAnchor(
    isForexOpen(now) ? now : nextMarketOpen(now)
  );
  const weekKey = weekKeyFor(anchor);
  const { weekStart, weekEnd } = weekBounds(anchor);
  return { weekKey, weekStart, weekEnd };
}

interface DeterministicOutlook {
  pairCode: PairCode;
  bias: WeeklyBias;
  confidence: number;
  headline: string;
  narrative: string;
  supports: number[];
  resistances: number[];
  scenarios: WeeklyOutlook['scenarios'];
  catalysts: string[];
  tradingPlan: string;
  price: number;
  confluence: Confluence;
}

function buildDeterministicOutlook(
  pair: PairCode,
  mtf: MultiTimeframe,
  weekEvents: LiveMarketEvent[],
  weekLabel: string
): DeterministicOutlook | null {
  const views: TimeframeView[] = [];
  for (const tf of HTF_ORDER) {
    const candles = mtf[tf];
    if (!candles || candles.length < 5) continue;
    const view = analyzeTimeframe(pair, tf, candles);
    if (view) views.push(view);
  }
  if (views.length < 3) return null;
  const conf = confluence(views, 0);
  if (!conf) return null;

  const bias: WeeklyBias =
    conf.direction === 'LONG'
      ? 'BULLISH'
      : conf.direction === 'SHORT'
        ? 'BEARISH'
        : 'NEUTRAL';
  const h1 = views.find((v) => v.timeframe === 'H1');
  const daily = views.find((v) => v.timeframe === 'DAILY');
  const price = h1?.price ?? daily?.price ?? views[views.length - 1].price;
  const atrValue = daily?.atr ?? h1?.atr ?? null;
  const atrP = atrValue !== null ? toPips(pair, atrValue) : 30;

  const byTf = (tf: Timeframe) => views.find((v) => v.timeframe === tf);
  const monthly = byTf('MONTHLY');
  const weekly = byTf('WEEKLY');

  const line = (v?: TimeframeView) =>
    v
      ? `${v.timeframe.toLowerCase()} ${v.bias.toLowerCase()} (${v.biasScore})`
      : null;
  const narrative = [
    monthly || weekly
      ? `Higher timeframes ${monthly && weekly && monthly.bias === weekly.bias ? `agree ${monthly.bias.toLowerCase()}` : `are mixed (${[line(monthly), line(weekly)].filter(Boolean).join(' vs ')})`} heading into ${weekLabel}.`
      : null,
    daily
      ? `The daily ${daily.bias.toLowerCase()} read (${daily.biasScore}) with H1 ATR near ${atrP.toFixed(0)} pips sets the day-trading range for the week.`
      : null,
    conf.direction === 'NEUTRAL'
      ? 'With no clear alignment, the edge is at the range edges — mid-range entries are the losing trade this week.'
      : `Intraday pullbacks ${conf.direction === 'LONG' ? 'into support' : 'into resistance'} in line with the ${bias.toLowerCase()} bias are the A-trade; counter-trend entries need a killzone rejection.`,
  ]
    .filter(Boolean)
    .join(' ');

  const swingLows = views
    .map((v) => v.swingLow)
    .filter((n): n is number => n !== null);
  const swingHighs = views
    .map((v) => v.swingHigh)
    .filter((n): n is number => n !== null);
  const supports = [...new Set(swingLows.map((n) => roundToPip(pair, n)))]
    .filter((n) => n < price)
    .sort((a, b) => b - a)
    .slice(0, 3);
  const resistances = [...new Set(swingHighs.map((n) => roundToPip(pair, n)))]
    .filter((n) => n > price)
    .sort((a, b) => a - b)
    .slice(0, 3);

  const res1 = resistances[0] ?? price + atrP * pipSize(pair) * 2;
  const sup1 = supports[0] ?? price - atrP * pipSize(pair) * 2;
  const scenarios: WeeklyOutlook['scenarios'] = {
    bull: {
      trigger: `Daily close above ${res1} with H1 holding higher lows`,
      target: roundToPip(pair, res1 + atrP * pipSize(pair)),
    },
    base: {
      trigger: `Range between ${sup1} and ${res1} — trade edges, skip the middle`,
      target: roundToPip(pair, price),
    },
    bear: {
      trigger: `Daily close below ${sup1} with H1 holding lower highs`,
      target: roundToPip(pair, sup1 - atrP * pipSize(pair)),
    },
  };

  const dayName = (d: Date) =>
    d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  const catalysts = weekEvents
    .filter((e) => e.impact !== 'LOW')
    .sort((a, b) => a.eventDate.getTime() - b.eventDate.getTime())
    .slice(0, 6)
    .map(
      (e) =>
        `${dayName(e.eventDate)} ${e.currency} ${e.impact.toLowerCase()} impact: ${e.title}`
    );
  if (catalysts.length === 0)
    catalysts.push(
      'No high-impact catalysts scheduled — a technical week; levels rule.'
    );

  const sessionFocus =
    pair === 'EUR/USD'
      ? 'London killzone (07–10 UTC) and the New York open (12–15 UTC)'
      : 'Tokyo/London handoff and the New York open (12–15 UTC)';
  const tradingPlan =
    `Focus on ${sessionFocus}; take only ${bias.toLowerCase()}-aligned entries at the listed ` +
    `levels with 12–30 pip stops sized to H1 ATR. ` +
    `If ${bias === 'BULLISH' ? sup1 : bias === 'BEARISH' ? res1 : 'the range edges'} breaks and holds into a session close, flip the intraday bias. ` +
    `Stand aside through red headline prints.`;

  return {
    pairCode: pair,
    bias,
    confidence: conf.confidence,
    headline: `${pair} leans ${bias.toLowerCase()} into ${weekLabel} (${conf.confidence}% conviction)`,
    narrative: narrative.slice(0, 2000),
    supports,
    resistances,
    scenarios,
    catalysts,
    tradingPlan: tradingPlan.slice(0, 1200),
    price,
    confluence: conf,
  };
}

function mergeOutlookAi(
  det: DeterministicOutlook,
  ai?: WeeklyAiOutlook
): Omit<DeterministicOutlook, 'price' | 'confluence'> & {
  engine: 'RULE_BASED' | 'DEEPSEEK';
} {
  if (!ai) return { ...det, engine: 'RULE_BASED' as const };
  return {
    pairCode: det.pairCode,
    bias: ai.bias,
    confidence: Math.max(15, Math.min(92, ai.confidence)),
    headline: ai.headline,
    narrative: ai.narrative,
    supports: ai.supports.length > 0 ? ai.supports : det.supports,
    resistances: ai.resistances.length > 0 ? ai.resistances : det.resistances,
    scenarios: {
      bull: { trigger: ai.bullTrigger, target: ai.bullTarget },
      base: { trigger: ai.baseTrigger, target: ai.baseTarget },
      bear: { trigger: ai.bearTrigger, target: ai.bearTarget },
    },
    catalysts: ai.catalysts.length > 0 ? ai.catalysts : det.catalysts,
    tradingPlan: ai.tradingPlan,
    engine: 'DEEPSEEK' as const,
  };
}

export async function getWeeklyOutlook(
  weekKey?: string
): Promise<WeeklyOutlook[]> {
  const key = weekKey ?? targetWeek(new Date()).weekKey;
  const rows = await prisma.weeklyOutlook.findMany({
    where: { weekKey: key },
    orderBy: { pairCode: 'asc' },
  });
  return rows.map(outlookFromRow);
}

/**
 * Creates the week's outlook if missing. Runs in maintenance (never on web
 * refresh). Deterministic core always; AI refinement when configured.
 */
export async function getOrCreateWeeklyOutlook(
  now = new Date(),
  options?: { force?: boolean }
): Promise<WeeklyOutlook[]> {
  const { weekKey, weekStart, weekEnd } = targetWeek(now);
  const existing = await prisma.weeklyOutlook.findMany({ where: { weekKey } });
  if (existing.length >= pairs.length && !options?.force) {
    return existing.map(outlookFromRow);
  }

  if (!liveDataEnabled()) return existing.map(outlookFromRow);

  const nowMs = now.getTime();
  if (
    !options?.force &&
    nowMs - lastOutlookGenerationAttempt < OUTLOOK_GENERATION_COOLDOWN_MS
  ) {
    return existing.map(outlookFromRow);
  }
  lastOutlookGenerationAttempt = nowMs;

  const weekLabel = `week of ${weekStart.toISOString().slice(0, 10)}`;
  let weekEvents: LiveMarketEvent[] = [];
  try {
    weekEvents = await fetchWeekEvents(weekStart);
  } catch (error) {
    console.warn(
      'Week-ahead calendar unavailable for the outlook.',
      error instanceof Error ? error.message : error
    );
  }

  const dets: DeterministicOutlook[] = [];
  for (const pair of pairs) {
    try {
      const mtf = await fetchMultiTimeframe(pair);
      const det = buildDeterministicOutlook(pair, mtf, weekEvents, weekLabel);
      if (det) dets.push(det);
      else console.warn(`Insufficient HTF context for the ${pair} outlook.`);
    } catch (error) {
      console.warn(
        `HTF fetch failed for the ${pair} outlook.`,
        error instanceof Error ? error.message : error
      );
    }
  }
  if (dets.length === 0) return existing.map(outlookFromRow);

  let aiOuts: WeeklyAiOutlook[] = [];
  if (aiAnalysisEnabled()) {
    try {
      aiOuts = await requestWeeklyAnalysis(
        dets.map((d) => ({
          pairCode: d.pairCode,
          price: d.price,
          confluence: d.confluence,
          session: 'Weekend preparation',
          killzoneHint: 'Plan London/NY killzones for the week ahead.',
        })),
        weekEvents,
        weekLabel
      );
    } catch (error) {
      console.warn(
        'AI weekly refinement unavailable; publishing deterministic outlook.',
        error instanceof Error ? error.message : error
      );
    }
  }

  const modelName = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  const result: WeeklyOutlook[] = [];
  for (const det of dets) {
    const merged = mergeOutlookAi(
      det,
      aiOuts.find((o) => o.pairCode === det.pairCode)
    );
    try {
      const row = await prisma.weeklyOutlook.upsert({
        where: { weekKey_pairCode: { weekKey, pairCode: det.pairCode } },
        update: {
          bias: merged.bias as PrismaWeeklyBias,
          confidence: merged.confidence,
          headline: merged.headline,
          narrative: merged.narrative,
          supports: merged.supports as unknown as Prisma.InputJsonValue,
          resistances: merged.resistances as unknown as Prisma.InputJsonValue,
          scenarios: merged.scenarios as unknown as Prisma.InputJsonValue,
          catalysts: merged.catalysts as unknown as Prisma.InputJsonValue,
          tradingPlan: merged.tradingPlan,
          engine: merged.engine as PrismaPredictionEngine,
          modelName:
            merged.engine === 'DEEPSEEK' ? modelName : 'mtf-confluence-v2',
          weekStart,
          weekEnd,
        },
        create: {
          weekKey,
          pairCode: det.pairCode,
          bias: merged.bias as PrismaWeeklyBias,
          confidence: merged.confidence,
          headline: merged.headline,
          narrative: merged.narrative,
          supports: merged.supports as unknown as Prisma.InputJsonValue,
          resistances: merged.resistances as unknown as Prisma.InputJsonValue,
          scenarios: merged.scenarios as unknown as Prisma.InputJsonValue,
          catalysts: merged.catalysts as unknown as Prisma.InputJsonValue,
          tradingPlan: merged.tradingPlan,
          engine: merged.engine as PrismaPredictionEngine,
          modelName:
            merged.engine === 'DEEPSEEK' ? modelName : 'mtf-confluence-v2',
          weekStart,
          weekEnd,
        },
      });
      result.push(outlookFromRow(row));
    } catch (error) {
      console.warn(
        `Unable to store the ${det.pairCode} weekly outlook.`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return result.length > 0 ? result : existing.map(outlookFromRow);
}

async function syncEventsSafely(now: Date) {
  const events = await fetchLiveEvents(now);
  for (const event of events) {
    await prisma.marketEvent.upsert({
      where: { externalId: event.externalId },
      update: {
        currency: event.currency,
        title: event.title,
        eventDate: event.eventDate,
        impact: event.impact,
        forecast: event.forecast,
        previousValue: event.previousValue,
      },
      create: event,
    });
  }
}

/**
 * Background maintenance, run periodically by the server. This is the only
 * place that calls the live providers for normal operation — web refreshes
 * read the database instead. It synchronizes the calendar, settles expired
 * signals against the live feed, generates the current window's signals while
 * the market is open, and keeps the weekly outlook fresh.
 * `force: true` bypasses the generation cooldowns (used by explicit retries).
 */
export async function maintainMarketData(
  now = new Date(),
  options?: { force?: boolean }
) {
  // Single-flight: the scheduler tick and a user's "Retry" (or several users
  // retrying at once) used to run overlapping passes, each one missing the
  // still-empty cache and firing its own round of provider calls.
  if (maintenanceRun) return maintenanceRun;
  // A forced pass bypasses the provider cooldowns, and any signed-in user can
  // ask for one; cap how often that may happen across the whole server.
  let force = options?.force ?? false;
  if (force) {
    if (Date.now() - lastForcedRun < FORCED_RUN_COOLDOWN_MS) force = false;
    else lastForcedRun = Date.now();
  }
  maintenanceRun = runMaintenance(now, { force }).finally(() => {
    maintenanceRun = null;
  });
  return maintenanceRun;
}

let maintenanceRun: Promise<void> | null = null;

// Live progress reads cached M15 candles; this is the only thing that
// refreshes them mid-window. One credit per pair per refresh, so the default
// 30 minutes costs ~4 credits/hour while signals are open (~100/day on a
// weekday, against the free plan's 800). LIVE_PROGRESS_REFRESH_MINUTES=0
// turns it off — live progress then updates only when signals are generated.
const LIVE_REFRESH_MS =
  Math.max(0, Number(process.env.LIVE_PROGRESS_REFRESH_MINUTES ?? 30)) * 60_000;
let lastLiveRefresh = 0;

async function refreshLiveCandles(active: Prediction[], now: Date) {
  if (LIVE_REFRESH_MS === 0 || active.length === 0) return;
  if (now.getTime() - lastLiveRefresh < LIVE_REFRESH_MS) return;
  lastLiveRefresh = now.getTime();
  for (const pairCode of new Set(active.map((p) => p.pairCode))) {
    // Served from cache when it is still fresh (20-minute TTL), so this never
    // buys the same series twice.
    await fetchTimeframeCandles(pairCode, 'M15').catch((error) =>
      console.warn(
        `M15 refresh failed for ${pairCode}.`,
        error instanceof Error ? error.message : error
      )
    );
  }
}
const FORCED_RUN_COOLDOWN_MS = 5 * 60_000;
let lastForcedRun = 0;

async function runMaintenance(now: Date, options?: { force?: boolean }) {
  if (liveDataEnabled()) {
    try {
      await syncEventsSafely(now);
    } catch (error) {
      console.warn(
        'Live economic calendar unavailable.',
        error instanceof Error ? error.message : error
      );
    }
  }
  await evaluateExpiredPredictions(now);
  // Intraday signals only make sense while the market is tradeable.
  if (isForexOpen(now)) {
    const active = await getOrCreatePredictions(now, options);
    await refreshLiveCandles(active, now);
  }
  // The weekend outlook is maintained at all times so it is ready before the close.
  try {
    await getOrCreateWeeklyOutlook(now, options);
  } catch (error) {
    console.warn(
      'Weekly outlook maintenance failed.',
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Last known prices, read-only from the candle cache the engine already keeps
 * (never triggers provider calls). The newest M15 close is the price; the
 * change is measured against the previous daily close. Stale entries are still
 * shown — with their own timestamp — because the last real price is more
 * useful than a blank, especially over the weekend.
 */
async function peekPrices(): Promise<TickerPrice[]> {
  const out: TickerPrice[] = [];
  for (const pair of pairs) {
    const [m15, h1, daily] = await Promise.all([
      peekStale<Candle[]>(`twelvedata:tf:${pair}:M15`).catch(() => null),
      peekStale<Candle[]>(`twelvedata:tf:${pair}:H1`).catch(() => null),
      peekStale<Candle[]>(`twelvedata:tf:${pair}:DAILY`).catch(() => null),
    ]);
    // Series come back newest-first from the provider.
    const latest = [m15?.[0], h1?.[0]]
      .filter((candle): candle is Candle => Boolean(candle))
      .sort((a, b) => candleTime(b) - candleTime(a))[0];
    if (!latest) {
      out.push({
        pairCode: pair,
        price: null,
        changePercent: null,
        asOf: null,
      });
      continue;
    }
    const latestDay = latest.datetime.slice(0, 10);
    const previousClose = daily?.find(
      (candle) => candle.datetime < latestDay
    )?.close;
    out.push({
      pairCode: pair,
      price: latest.close,
      changePercent: previousClose
        ? Number(
            (((latest.close - previousClose) / previousClose) * 100).toFixed(3)
          )
        : null,
      asOf: new Date(candleTime(latest)).toISOString(),
    });
  }
  return out;
}

export async function getDashboardFromDatabase(
  now = new Date()
): Promise<DashboardData> {
  const liveEnabled = liveDataEnabled();
  const open = isForexOpen(now);
  const info = sessionInfo(now);
  const { weekKey } = targetWeek(now);

  // Read-only dashboard: no provider calls happen on web refreshes.
  const [predictions, eventRows, history, outlookRows, prices] =
    await Promise.all([
      open ? getCurrentPredictions(now) : Promise.resolve([]),
      prisma.marketEvent.findMany({
        where: { eventDate: { gte: now } },
        orderBy: { eventDate: 'asc' },
        take: 6,
      }),
      getHistory(12, now),
      prisma.weeklyOutlook.findMany({
        where: { weekKey },
        orderBy: { pairCode: 'asc' },
      }),
      peekPrices(),
    ]);

  const [totalSignals, average, hits, misses] = await Promise.all([
    prisma.prediction.count(),
    prisma.prediction.aggregate({ _avg: { confidence: true } }),
    prisma.predictionOutcome.count({ where: { status: 'HIT' } }),
    prisma.predictionOutcome.count({ where: { status: 'MISSED' } }),
  ]);

  const resolved = hits + misses;
  const empty = createEmptyDashboard(now);
  const weeklyOutlook = outlookRows.map(outlookFromRow);
  const dataAvailable =
    predictions.length > 0 ||
    history.length > 0 ||
    eventRows.length > 0 ||
    weeklyOutlook.length > 0;

  const withLive = await Promise.all(
    predictions.map(async (p) => ({ ...p, live: await liveProgress(p) }))
  );

  return {
    ...empty,
    marketStatus: open ? 'OPEN' : 'CLOSED',
    predictions: withLive,
    history,
    events: eventRows.map(eventFromRow),
    prices,
    weeklyOutlook,
    currentSession: open ? info.session : 'Market closed',
    killzoneLabel: open ? info.killzoneLabel : null,
    playbookHint: open ? info.playbookHint : null,
    stats: {
      totalSignals,
      avgConfidence:
        average._avg.confidence === null
          ? 0
          : Math.round(average._avg.confidence),
      hitRate: resolved > 0 ? Number(((hits / resolved) * 100).toFixed(1)) : 0,
      nextRefresh: open
        ? signalWindowEnd(now).toISOString()
        : nextMarketOpen(now).toISOString(),
    },
    liveDataEnabled: liveEnabled,
    dataAvailable,
  };
}
