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
  type DashboardData,
  type Direction,
  type LiveProgress,
  type OutcomeStatus,
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
  tradingWindowAt,
  nextWindowStart,
  type TradingWindow,
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
import { announceMyTradeClosed, announceSignalEvent } from './alerts.js';

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
    status: row.status as OutcomeStatus,
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
    continuesId: row.continuesId === null ? null : String(row.continuesId),
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
      // Legacy "hold" rows are not signals of their own.
      continuesId: null,
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

/** Asia window: minimum confidence for a published trade. */
const STRICT_MIN_CONFIDENCE = 70;
/** Most trades per pair per window (the first call plus one re-check). */
export const MAX_SIGNALS_PER_WINDOW = 2;

/** Engine version recorded on rule-built signals. */
const ENGINE_MODEL = 'ctx-h1-exec-v3';

/** Intraday model: Daily + H4 context, H1 execution, M15 confirmation. */
export const INTRADAY_TIMEFRAMES: Timeframe[] = ['DAILY', 'H4', 'H1', 'M15'];
/** H1 bars that define the execution structure (stop placement). */
const H1_STRUCTURE_BARS = 10;

function catalystPenalty(
  events: LiveMarketEvent[],
  now: Date,
  until: Date = new Date(now.getTime() + 5 * 3_600_000)
): number {
  const windowEnd = until.getTime();
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
  now: Date,
  options: {
    /** Window end, for the catalyst look-ahead. */
    windowEnd?: Date;
    /** Lighter window (Asia): publish only fully aligned, high-confidence setups. */
    strict?: boolean;
    /** Re-check after a stop: H1 must positively agree with the context. */
    requireH1Aligned?: boolean;
  } = {}
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

  const penalty = catalystPenalty(events, now, options.windowEnd);
  const conf = intradayConfluence(views, penalty);
  if (!conf) return null;
  if (conf.direction !== 'NEUTRAL') {
    if (
      options.strict &&
      (conf.confidence < STRICT_MIN_CONFIDENCE || !conf.h1Aligned)
    ) {
      conf.notes.unshift(
        `${session} is a lighter window: only fully aligned setups (${STRICT_MIN_CONFIDENCE}%+ confidence, H1 aligned) are published.`
      );
      conf.direction = 'NEUTRAL';
    } else if (options.requireH1Aligned && !conf.h1Aligned) {
      conf.notes.unshift(
        'After a stop, H1 must clearly agree with the context again before a new entry.'
      );
      conf.direction = 'NEUTRAL';
    }
  }

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
 * A signal covers the rest of its session window (Asia 00–07, London 07–12,
 * New York 12–17 UTC). Outside the windows nothing new is published.
 */
export function signalWindowEnd(now: Date): Date {
  return tradingWindowAt(now)?.end ?? now;
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
    continuesId: null,
    pairCode: signal.pairCode,
    windowKey: tradingWindowAt(now)?.key ?? now.toISOString().slice(0, 13),
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
    session: tradingWindowAt(now)?.label ?? 'Off hours',
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
      continuesId: prediction.continuesId
        ? Number(prediction.continuesId)
        : null,
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

/**
 * Builds the current-window signals from multi-timeframe market data.
 * Deterministic indicators always run; DeepSeek refines when configured.
 */
interface GenerationTarget {
  pair: PairCode;
  /** Set when this is an early re-check after the pair's trade closed. */
  rearmAfter?: 'target' | 'stopped';
}

async function liveIntradayPredictions(
  now: Date,
  window: TradingWindow,
  targets: GenerationTarget[]
): Promise<Prediction[]> {
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
  for (const { pair, rearmAfter } of targets) {
    try {
      // Only the four intraday timeframes: monthly/weekly are not needed here
      // (and skipping them saves provider credits).
      const mtf = await fetchMultiTimeframe(pair, INTRADAY_TIMEFRAMES);
      const signal = buildDeterministicSignal(
        pair,
        mtf,
        events,
        window.label,
        info.playbookHint,
        now,
        {
          windowEnd: window.end,
          strict: window.strict,
          requireH1Aligned: rearmAfter === 'stopped',
        }
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
          session: window.label,
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
async function liveProgress(
  p: Prediction,
  until: Date = new Date(p.expiresAt)
): Promise<LiveProgress | null> {
  const cached = await peekStale<Candle[]>(
    `twelvedata:tf:${p.pairCode}:M15`
  ).catch(() => null);
  if (!cached || cached.length === 0) return null;
  const span = 15 * 60_000;
  const from = new Date(p.validFrom).getTime();
  const to = until.getTime();
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
 * A triggered trade is followed past its window until it reaches its target
 * or stop. Day trades are not carried over the weekend gap, so anything still
 * open at the Friday close of its week is closed there at the last price.
 */
export function tradeHoldUntil(validFrom: Date): Date {
  return nextMarketClose(validFrom);
}

const OPEN_TRADE_NOTE =
  'Triggered in its window and still open — tracked until target, stop or the Friday close.';

/**
 * Settles expired signals from their price path, in two phases:
 * 1. The window: no fill in the entry zone means no trade (EXPIRED, not
 *    scored); a target or stop inside the window settles it.
 * 2. After the window: a trade that filled and is still running stays open
 *    (PENDING, with its running pips) until target or stop trades, or the
 *    Friday close, where it is marked to the last price.
 * Windows the candle history can no longer cover are closed as unscored
 * instead of being judged against a later price.
 *
 * Returns the pairs that still have open trades, so maintenance can keep
 * their candles fresh.
 */
export async function evaluateExpiredPredictions(
  now = new Date()
): Promise<Set<PairCode>> {
  const openPairs = new Set<PairCode>();
  if (!liveDataEnabled()) return openPairs;

  const pending = await prisma.prediction.findMany({
    where: {
      expiresAt: { lte: now },
      outcome: { is: { status: 'PENDING' } },
    },
    include: { outcome: true },
  });
  if (pending.length === 0) return openPairs;

  // One series per pair and timeframe for the whole batch. The cached copy is
  // used when it already covers what is needed; the provider is only asked
  // (through the cache + credit budget) when it does not. Open trades past
  // their window ride on the throttled live refresh instead.
  const series = new Map<string, Candle[]>();
  async function candlesFor(
    pair: PairCode,
    timeframe: Timeframe,
    needUntil: Date
  ) {
    const key = `${pair}:${timeframe}`;
    const known = series.get(key);
    const span = CANDLE_MS[timeframe] ?? 60 * 60_000;
    const covers = (candles: Candle[] | null | undefined) =>
      Boolean(candles?.length) &&
      Math.max(...candles!.map(candleTime)) + span >= needUntil.getTime();
    if (covers(known)) return known!;
    const cached = await peekStale<Candle[]>(
      `twelvedata:tf:${pair}:${timeframe}`
    ).catch(() => null);
    if (covers(cached)) {
      series.set(key, cached!);
      return cached!;
    }
    try {
      const fresh = await fetchTimeframeCandles(pair, timeframe);
      series.set(key, fresh);
      return fresh;
    } catch (error) {
      console.warn(
        `No ${timeframe} candles to settle ${pair}; its signals stay pending.`,
        error instanceof Error ? error.message : error
      );
      const fallback = cached ?? known ?? [];
      series.set(key, fallback);
      return fallback;
    }
  }

  const store = async (
    row: DbPrediction,
    data: Settlement & { status: PrismaOutcomeStatus }
  ) => {
    const rowId = row.id;
    try {
      await prisma.predictionOutcome.update({
        where: { predictionId: rowId },
        data: {
          ...data,
          evaluatedAt: now,
          source: 'LIVE' as PrismaOutcomeSource,
        },
      });
    } catch (error) {
      console.warn(
        `Unable to store the outcome for prediction ${rowId}.`,
        error instanceof Error ? error.message : error
      );
      return;
    }
    // Usually already announced live by the M15 tracker; this is the backstop.
    if (data.status === 'HIT' || data.status === 'MISSED') {
      await announceSignalEvent(
        data.status === 'HIT' ? 'TARGET_HIT' : 'STOP_HIT',
        fromRow(row),
        { pips: data.movementPips },
        // Settled long after the fact (e.g. after downtime): log only.
        { silent: now.getTime() - row.expiresAt.getTime() > STALE_ALERT_MS }
      ).catch(() => undefined);
    }
  };

  for (const row of pending) {
    const pair = row.pairCode as PairCode;
    const levels: LevelRow = {
      pairCode: row.pairCode,
      direction: row.direction,
      entryLow: Number(row.entryLow),
      entryHigh: Number(row.entryHigh),
      targetPrice: Number(row.targetPrice),
      invalidationPrice: Number(row.invalidationPrice),
    };

    // A hold call manages an earlier open trade; it is never a trade itself.
    if (row.continuesId !== null) {
      await store(row, {
        status: 'EXPIRED',
        resolvedPrice: null,
        movementPips: null,
        note: 'Hold — managed an earlier open trade; not scored separately.',
      });
      continue;
    }

    // Phase 1: the signal's own window.
    let windowPath: Candle[] | null = null;
    let windowTf: Timeframe = 'M15';
    for (const timeframe of ['M15', 'H1'] as const) {
      windowPath = windowCandles(
        await candlesFor(pair, timeframe, row.expiresAt),
        timeframe,
        row.validFrom,
        row.expiresAt
      );
      if (windowPath) {
        windowTf = timeframe;
        break;
      }
    }
    if (!windowPath) {
      if (now.getTime() - row.expiresAt.getTime() > SETTLEMENT_GRACE_MS) {
        await store(row, {
          status: 'EXPIRED',
          resolvedPrice: null,
          movementPips: null,
          note: 'Not scored — no price data covering this window was available.',
        });
      }
      continue; // Otherwise the newest candles are not published yet.
    }
    const inWindow = replayPath(levels, windowPath);
    if (inWindow.state !== 'running') {
      await store(row, settleFromCandles(levels, windowPath));
      continue;
    }

    // Phase 2: filled in its window and still open — follow it.
    const holdUntil = tradeHoldUntil(row.validFrom);
    const until = now < holdUntil ? now : holdUntil;
    const span = CANDLE_MS[windowTf] ?? 60 * 60_000;
    const all = (series.get(`${pair}:${windowTf}`) ?? [])
      .slice()
      .sort((x, y) => candleTime(x) - candleTime(y))
      .filter(
        (c) =>
          candleTime(c) + span > row.validFrom.getTime() &&
          candleTime(c) < until.getTime()
      );
    const path = replayPath(levels, all);
    if (path.state === 'target' || path.state === 'stopped') {
      const hit = path.state === 'target';
      await store(row, {
        status: hit ? 'HIT' : 'MISSED',
        resolvedPrice: hit ? levels.targetPrice : levels.invalidationPrice,
        movementPips: path.pips,
        note: hit
          ? 'Target reached after the window closed (the trade was followed until target or stop).'
          : 'Invalidation traded after the window closed (the trade was followed until target or stop).',
      });
      continue;
    }
    const lastEnd = all.length ? candleTime(all[all.length - 1]) + span : 0;
    if (now >= holdUntil && lastEnd >= holdUntil.getTime()) {
      await store(row, {
        status: 'EXPIRED',
        resolvedPrice: path.lastClose,
        movementPips: path.pips,
        note: 'Still open at the Friday close — closed there and marked to the last price.',
      });
      continue;
    }
    // Still running: keep it open and record where it stands.
    openPairs.add(pair);
    await store(row, {
      status: 'PENDING',
      resolvedPrice: null,
      movementPips: path.pips,
      note: OPEN_TRADE_NOTE,
    });
  }
  return openPairs;
}

function utcClock(iso: string) {
  return `${new Date(iso).toISOString().slice(11, 16)} UTC`;
}

export type OpenTradeDecision =
  | { action: 'publish'; signal: Prediction }
  | { action: 'carry'; prior: Prediction; reconfirmed: boolean };

/**
 * How a new window's read relates to a trade on the same pair that is still
 * running from an earlier window:
 * - same direction → carry: the original trade stays the pair's signal
 *   ("still valid"), nothing new is published or counted;
 * - neutral → carry as well, marked not re-confirmed (manage it on its own
 *   levels) — a stand-aside next to an open trade only confuses;
 * - opposite direction → a new signal is published, with a warning to close
 *   or reduce the open trade first.
 */
export function openTradeDecision(
  signal: Prediction,
  open: Prediction[]
): OpenTradeDecision {
  const prior = open.find((t) => t.pairCode === signal.pairCode);
  if (!prior) return { action: 'publish', signal };
  if (signal.direction === prior.direction)
    return { action: 'carry', prior, reconfirmed: true };
  if (signal.direction === 'NEUTRAL')
    return { action: 'carry', prior, reconfirmed: false };
  const side = prior.direction === 'LONG' ? 'long' : 'short';
  const opened = utcClock(prior.validFrom);
  return {
    action: 'publish',
    signal: {
      ...signal,
      factors: [
        `Conflicts with the open ${opened} ${side} — close or reduce it before taking this one`,
        ...signal.factors,
      ].slice(0, 5),
      playbook:
        `The ${opened} ${side} is still open and points the other way: close or reduce it first. ${signal.playbook ?? ''}`.slice(
          0,
          600
        ),
    },
  };
}

/** Event kind recording that a window's analysis carried an open trade. */
function carryKind(windowKey: string, reconfirmed: boolean) {
  return `CARRY:${windowKey}:${reconfirmed ? 'SAME' : 'NEUTRAL'}`;
}

async function carriedThisWindow(predictionId: string, windowKey: string) {
  const found = await prisma.signalEvent.findFirst({
    where: {
      predictionId: Number(predictionId),
      kind: { startsWith: `CARRY:${windowKey}:` },
    },
  });
  return Boolean(found);
}

// ---- Trade management on H1 closes ------------------------------------------
//
// H1 is the execution timeframe, so each closed H1 candle is a checkpoint:
// - before entry, a setup that breaks is cancelled (not scored), and the pair
//   waits for a clearer sign (re-read at a later H1 close with H1 required to
//   agree again);
// - after entry, a trade is closed early only on two pieces of evidence on the
//   same H1 close: price back through the far side of the entry zone AND H1 or
//   H4 now pointing against the trade. One wobble is what the stop is for.

export interface ManageDecision {
  action: 'none' | 'cancel' | 'exit';
  reason: string;
}

const AGAINST = 15;

export function decideOnH1Close(input: {
  direction: 'LONG' | 'SHORT';
  state: 'waiting' | 'running';
  entryLow: number;
  entryHigh: number;
  invalidationPrice: number;
  h1Close: number;
  h1Score: number;
  h4Score: number | null;
  contextScore: number;
}): ManageDecision {
  const long = input.direction === 'LONG';
  const sign = long ? 1 : -1;
  const side = long ? 'long' : 'short';
  const against = long ? 'bearish' : 'bullish';
  const h1Against = sign * input.h1Score <= -AGAINST;
  const h4Against = input.h4Score !== null && sign * input.h4Score <= -AGAINST;
  const contextAgainst = sign * input.contextScore <= -AGAINST;

  if (input.state === 'waiting') {
    const beyondStop = long
      ? input.h1Close < input.invalidationPrice
      : input.h1Close > input.invalidationPrice;
    if (beyondStop)
      return {
        action: 'cancel',
        reason: `Cancelled before entry: H1 closed ${long ? 'below' : 'above'} the invalidation level without the zone filling.`,
      };
    if (contextAgainst)
      return {
        action: 'cancel',
        reason: `Cancelled before entry: the daily/H4 context turned ${against}.`,
      };
    if (h1Against)
      return {
        action: 'cancel',
        reason: `Cancelled before entry: H1 turned ${against} against the context. Waiting for a clearer sign.`,
      };
    return { action: 'none', reason: '' };
  }

  const backThrough = long
    ? input.h1Close < input.entryLow
    : input.h1Close > input.entryHigh;
  if (backThrough && (h1Against || h4Against)) {
    const which =
      h1Against && h4Against ? 'H1 and H4' : h1Against ? 'H1' : 'H4';
    return {
      action: 'exit',
      reason: `Exit suggested: H1 closed back ${long ? 'below' : 'above'} the entry zone and ${which} turned ${against} against the ${side}.`,
    };
  }
  return { action: 'none', reason: '' };
}

/** Last H1 close fully processed for every pair (gates the per-minute loop). */
let lastH1Pass = 0;
/** Last closed H1 candle processed per pair, so each candle is checked once. */
const lastManagedH1 = new Map<PairCode, number>();
const H1_MS = 60 * 60_000;
/** Give the provider a moment to publish the candle that just closed. */
const H1_PUBLISH_DELAY_MS = 2 * 60_000;

/**
 * Runs the H1-close checkpoint for every pending trade (current-window
 * signals and earlier trades still running). About one H1 request per pair
 * per hour, only while there is something to manage; no model calls.
 */
export async function manageOnH1Close(now = new Date()) {
  if (!liveDataEnabled() || !isForexOpen(now)) return;
  // Cheap timing gate first: nothing to do until a new H1 candle has closed
  // (and had a moment to publish), so the per-minute loop costs no queries.
  const hourStart = Math.floor(now.getTime() / H1_MS) * H1_MS;
  const lastClosedStart = hourStart - H1_MS;
  if (now.getTime() - hourStart < H1_PUBLISH_DELAY_MS) return;
  if (lastClosedStart <= lastH1Pass) return;

  const rows = await prisma.prediction.findMany({
    where: {
      direction: { not: 'NEUTRAL' },
      continuesId: null,
      validFrom: { lte: now, gte: new Date(now.getTime() - 7 * 24 * H1_MS) },
      outcome: { is: { status: 'PENDING' } },
    },
    include: { outcome: true },
  });
  if (rows.length === 0) {
    lastH1Pass = lastClosedStart;
    return;
  }

  // A pair whose candle isn't published yet is retried next minute.
  let deferred = false;
  for (const pair of new Set(rows.map((r) => r.pairCode as PairCode))) {
    if ((lastManagedH1.get(pair) ?? 0) >= lastClosedStart) continue;
    let h1: Candle[];
    let h4: Candle[] = [];
    let daily: Candle[] = [];
    try {
      h1 = await fetchTimeframeCandles(pair, 'H1', lastClosedStart);
      h4 = await fetchTimeframeCandles(pair, 'H4').catch(() => []);
      daily = await fetchTimeframeCandles(pair, 'DAILY').catch(() => []);
    } catch (error) {
      console.warn(
        `H1 checkpoint skipped for ${pair}.`,
        error instanceof Error ? error.message : error
      );
      deferred = true;
      continue;
    }
    // Only fully closed H1 candles (the provider also returns the live one).
    const closed = h1
      .filter((c) => candleTime(c) + H1_MS <= now.getTime())
      .sort((a, b) => candleTime(a) - candleTime(b));
    const last = closed[closed.length - 1];
    if (!last || candleTime(last) < lastClosedStart) {
      deferred = true; // not published yet
      continue;
    }
    lastManagedH1.set(pair, lastClosedStart);

    // Same indicators the engine uses; analyzeTimeframe expects newest-first.
    const h1View = analyzeTimeframe(pair, 'H1', [...closed].reverse());
    const h4View = h4.length >= 5 ? analyzeTimeframe(pair, 'H4', h4) : null;
    const dailyView =
      daily.length >= 5 ? analyzeTimeframe(pair, 'DAILY', daily) : null;
    if (!h1View) continue;
    const context = intradayConfluence(
      [dailyView, h4View, h1View].filter((v): v is TimeframeView => Boolean(v))
    );
    if (!context) continue;

    for (const row of rows.filter((r) => r.pairCode === pair)) {
      const p = fromRow(row);
      const path = replayPath(
        p,
        closed.filter((c) => candleTime(c) + H1_MS > row.validFrom.getTime())
      );
      // Target/stop already traded: settlement records it, nothing to manage.
      if (path.state !== 'waiting' && path.state !== 'running') continue;
      // An unfilled signal whose window is over is just "no position".
      if (path.state === 'waiting' && row.expiresAt <= now) continue;

      const decision = decideOnH1Close({
        direction: p.direction as 'LONG' | 'SHORT',
        state: path.state,
        entryLow: p.entryLow,
        entryHigh: p.entryHigh,
        invalidationPrice: p.invalidationPrice,
        h1Close: last.close,
        h1Score: h1View.biasScore,
        h4Score: h4View?.biasScore ?? null,
        contextScore: context.score,
      });
      if (decision.action === 'none') continue;

      const mid = (p.entryLow + p.entryHigh) / 2;
      const pips = Number(
        (
          (p.direction === 'LONG' ? last.close - mid : mid - last.close) /
          pipSize(pair)
        ).toFixed(1)
      );
      try {
        await prisma.predictionOutcome.update({
          where: { predictionId: row.id },
          data: {
            status: decision.action === 'cancel' ? 'CANCELLED' : 'CLOSED_EARLY',
            resolvedPrice: last.close,
            movementPips: decision.action === 'cancel' ? null : pips,
            evaluatedAt: now,
            source: 'LIVE' as PrismaOutcomeSource,
            note: decision.reason,
          },
        });
        console.info(`${pair} #${row.id}: ${decision.reason}`);
        await announceSignalEvent(
          decision.action === 'cancel' ? 'CANCELLED' : 'CLOSED_EARLY',
          p,
          {
            price: last.close,
            pips: decision.action === 'cancel' ? null : pips,
            note: decision.reason,
          }
        ).catch(() => undefined);
      } catch (error) {
        console.warn(
          `Unable to record the H1 checkpoint for prediction ${row.id}.`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }
  if (!deferred) lastH1Pass = lastClosedStart;
}

/**
 * Earlier signals that triggered in their window and are still running,
 * with live progress from the cached M15 candles. Read-only.
 */
export async function getOpenTrades(now = new Date()): Promise<Prediction[]> {
  const rows = await prisma.prediction.findMany({
    where: {
      expiresAt: { lte: now },
      direction: { not: 'NEUTRAL' },
      continuesId: null,
      outcome: { is: { status: 'PENDING' } },
    },
    include: { outcome: true },
    orderBy: { validFrom: 'desc' },
    take: 10,
  });
  const trades: Prediction[] = [];
  for (const row of rows) {
    const p = fromRow(row);
    const holdUntil = tradeHoldUntil(row.validFrom);
    const live = await liveProgress(p, now < holdUntil ? now : holdUntil);
    // Only trades that actually filled; unfilled windows are just awaiting settlement.
    if (live && live.state !== 'waiting' && live.state !== 'neutral') {
      trades.push({ ...p, live });
    }
  }
  return trades;
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

/** Announces a newly published trade (holds and stand-asides are not alerted). */
async function announceNew(row: DbPrediction) {
  const p = fromRow(row);
  if (p.direction === 'NEUTRAL' || p.continuesId) return;
  await announceSignalEvent('SIGNAL_NEW', p).catch((error) =>
    console.warn(
      'New-signal alert failed.',
      error instanceof Error ? error.message : error
    )
  );
}

/** Hard cap on calls per pair per window, cancelled ones included. */
const MAX_CALLS_PER_WINDOW = 4;

/**
 * Room for another trade in this window: at most MAX_SIGNALS_PER_WINDOW
 * trades (cancelled-before-entry calls don't count, they were never trades)
 * and MAX_CALLS_PER_WINDOW calls overall.
 */
async function windowHasRoom(pair: PairCode, window: TradingWindow) {
  const inWindow = { pairCode: pair, windowKey: { startsWith: window.key } };
  const [calls, cancelled] = await Promise.all([
    prisma.prediction.count({ where: inWindow }),
    prisma.prediction.count({
      where: { ...inWindow, outcome: { is: { status: 'CANCELLED' } } },
    }),
  ]);
  return (
    calls - cancelled < MAX_SIGNALS_PER_WINDOW && calls < MAX_CALLS_PER_WINDOW
  );
}

/** Re-checks are attempted at most once per pair per H1 candle. */
const lastRearmCheck = new Map<PairCode, string>();
/** Leave at least this long in the window for a re-check trade to work. */
const REARM_MIN_TIME_LEFT_MS = 45 * 60_000;

/** The first H1 close after a trade closed inside the M15 candle at `closedAt`. */
function nextH1Close(closedAt: string): Date {
  const t = new Date(new Date(closedAt).getTime() + 15 * 60_000);
  const close = new Date(t);
  close.setUTCMinutes(0, 0, 0);
  if (close < t) close.setUTCHours(close.getUTCHours() + 1);
  return close;
}

/**
 * Creates the signals for the current session window and, during London
 * and New York, re-checks a pair early when its trade has already reached
 * target or stop:
 * - at the first H1 close after it closed (H1 is the execution timeframe);
 * - after a stop, H1 must clearly agree with the context again;
 * - at most MAX_SIGNALS_PER_WINDOW trades per pair per window, at most one
 *   re-check per H1 candle, and not in the last 45 minutes of the window.
 * Nothing is generated outside the windows (17:00–24:00 UTC, weekends).
 *
 * Free-tier friendly: stored signals are reused until they expire; failed
 * first-generation attempts back off for 15 minutes (`force` bypasses it).
 */
export async function getOrCreatePredictions(
  now = new Date(),
  options?: { force?: boolean }
): Promise<Prediction[]> {
  if (!liveDataEnabled()) return [];
  const window = tradingWindowAt(now);
  if (!window) return getCurrentPredictions(now);

  const activeRows = await Promise.all(
    pairs.map((pair) => activePrediction(pair, now))
  );
  // Earlier trades still running: a window's analysis may carry them forward.
  const open = await getOpenTrades(now).catch(() => [] as Prediction[]);
  const targets: GenerationTarget[] = [];
  const closedRows = new Map<PairCode, DbPrediction>();

  for (const [index, pair] of pairs.entries()) {
    const active = activeRows[index];
    if (!active) {
      // Already analysed this window and carried the open trade: nothing to do.
      const prior = open.find((t) => t.pairCode === pair);
      if (prior && (await carriedThisWindow(prior.id, window.key))) continue;
      targets.push({ pair });
      continue;
    }
    // Early re-check: only for a real trade that is already finished — by
    // target or stop, or by the H1 checkpoint (cancelled / closed early).
    if (
      !window.rearm ||
      active.direction === 'NEUTRAL' ||
      active.continuesId !== null
    )
      continue;
    const status = active.outcome?.status;
    let checkAt: Date;
    let after: GenerationTarget['rearmAfter'];
    if (
      (status === 'CANCELLED' || status === 'CLOSED_EARLY') &&
      active.outcome?.evaluatedAt
    ) {
      // Wait for a clearer sign: at least the next H1 close, H1 aligned again.
      checkAt = nextH1Close(active.outcome.evaluatedAt.toISOString());
      after = 'stopped';
    } else {
      const live = await liveProgress(fromRow(active));
      if (
        !live ||
        (live.state !== 'target' && live.state !== 'stopped') ||
        !live.closedAt
      )
        continue;
      checkAt = nextH1Close(live.closedAt);
      after = live.state;
    }
    if (
      now < checkAt ||
      window.end.getTime() - now.getTime() < REARM_MIN_TIME_LEFT_MS
    )
      continue;
    const hourKey = now.toISOString().slice(0, 13);
    if (lastRearmCheck.get(pair) === hourKey) continue;
    if (!(await windowHasRoom(pair, window))) continue;
    lastRearmCheck.set(pair, hourKey);
    targets.push({ pair, rearmAfter: after });
    closedRows.set(pair, active);
  }

  if (targets.length === 0) return getCurrentPredictions(now);

  // First-generation attempts share the failure cooldown; re-checks are
  // already limited to one per H1 candle.
  const firstGen = targets.filter((t) => !t.rearmAfter);
  if (firstGen.length > 0 && !options?.force) {
    if (now.getTime() - lastAiGenerationAttempt < AI_GENERATION_COOLDOWN_MS) {
      const rearms = targets.filter((t) => t.rearmAfter);
      targets.splice(0, targets.length, ...rearms);
    } else {
      lastAiGenerationAttempt = now.getTime();
    }
  }
  if (targets.length === 0) return getCurrentPredictions(now);

  let signals: Prediction[] = [];
  try {
    signals = await liveIntradayPredictions(now, window, targets);
    // Same direction (or neutral) as a trade still running: carry that trade
    // instead of publishing — one trade, counted once.
    const published: Prediction[] = [];
    for (const signal of signals) {
      const decision = openTradeDecision(signal, open);
      if (decision.action === 'publish') {
        published.push(decision.signal);
        continue;
      }
      await prisma.signalEvent
        .create({
          data: {
            predictionId: Number(decision.prior.id),
            kind: carryKind(window.key, decision.reconfirmed),
          },
        })
        .catch(() => undefined); // already recorded this window
      console.info(
        `${signal.pairCode}: ${window.label} analysis ${decision.reconfirmed ? 're-confirmed' : 'is neutral on'} the open trade #${decision.prior.id}; carried, nothing new published.`
      );
    }
    signals = published;
  } catch (error) {
    console.warn(
      'Intraday generation unavailable; keeping the stored signals.',
      error instanceof Error ? error.message : error
    );
    return getCurrentPredictions(now);
  }

  for (const target of targets) {
    const signal = signals.find((s) => s.pairCode === target.pair);
    if (!signal) continue;
    try {
      if (target.rearmAfter) {
        // A re-check only publishes a new trade; a stand-aside keeps the
        // closed trade on screen until the window ends.
        if (signal.direction === 'NEUTRAL') {
          console.info(
            `Re-check for ${target.pair}: no new setup this candle.`
          );
          continue;
        }
        if (!(await windowHasRoom(target.pair, window))) continue;
        // Keys count every call in the window (cancelled ones included).
        const used = await prisma.prediction.count({
          where: {
            pairCode: target.pair,
            windowKey: { startsWith: window.key },
          },
        });
        const closed = closedRows.get(target.pair);
        // The closed trade is finished: end it now so it settles and moves
        // to history, and the new call becomes the active one.
        if (closed) {
          await prisma.prediction.update({
            where: { id: closed.id },
            data: { expiresAt: now },
          });
        }
        const created = await insertPrediction({
          ...signal,
          windowKey: `${window.key}-${used + 1}`,
        });
        await announceNew(created);
      } else {
        await announceNew(await insertPrediction(signal));
      }
    } catch (error) {
      // Window race (unique pairCode + windowKey): keep what is stored.
      console.warn(
        `Unable to store signal for ${target.pair}.`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return getCurrentPredictions(now);
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
      // Legacy "hold" rows managed another trade; they are not results.
      continuesId: null,
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

// ---- Candle-close loop ---------------------------------------------------------
//
// Runs every minute but only acts once per closed M15 candle, and only when
// something is open:
// - refreshes M15 for pairs with open signals / trades / journal trades
//   (1 credit per pair per refresh; at most every LIVE_PROGRESS_REFRESH_MINUTES,
//   default 15 → ~4 credits per pair per hour while something is open);
// - announces entry fills, targets and stops as soon as they show up;
// - closes users' journal trades at their own stop or target;
// - runs the H1 checkpoint (it throttles itself to one pass per H1 close).

const M15_MS = 15 * 60_000;
/** Events older than this are recorded but not alerted. */
const STALE_ALERT_MS = 2 * 60 * 60_000;
const LIVE_REFRESH_MS =
  Math.max(0, Number(process.env.LIVE_PROGRESS_REFRESH_MINUTES ?? 15)) * 60_000;
let lastTrackedM15 = 0;
const lastM15Refresh = new Map<PairCode, number>();
let candleLoopRun: Promise<void> | null = null;

export function onCandleClose(now = new Date()) {
  if (candleLoopRun) return candleLoopRun;
  candleLoopRun = (async () => {
    await manageOnH1Close(now).catch((error) =>
      console.warn(
        'H1 checkpoint failed.',
        error instanceof Error ? error.message : error
      )
    );
    await trackOnM15Close(now).catch((error) =>
      console.warn(
        'M15 tracking failed.',
        error instanceof Error ? error.message : error
      )
    );
  })().finally(() => {
    candleLoopRun = null;
  });
  return candleLoopRun;
}

async function trackOnM15Close(now: Date) {
  if (!liveDataEnabled() || !isForexOpen(now)) return;
  const lastClosedStart = Math.floor(now.getTime() / M15_MS) * M15_MS - M15_MS;
  // Once per M15 close, a minute after it (the provider needs to publish it).
  if (lastClosedStart <= lastTrackedM15) return;
  if (now.getTime() - (lastClosedStart + M15_MS) < 60_000) return;
  lastTrackedM15 = lastClosedStart;

  const since = new Date(now.getTime() - 7 * 24 * 3_600_000);
  const [trades, userTrades] = await Promise.all([
    prisma.prediction.findMany({
      where: {
        direction: { not: 'NEUTRAL' },
        continuesId: null,
        validFrom: { lte: now, gte: since },
        outcome: { is: { status: 'PENDING' } },
      },
      include: { outcome: true },
    }),
    prisma.userTrade.findMany({
      where: {
        exitPrice: null,
        OR: [{ stopPrice: { not: null } }, { targetPrice: { not: null } }],
        prediction: { validFrom: { gte: since } },
      },
      include: { prediction: { include: { outcome: true } } },
    }),
  ]);
  if (trades.length === 0 && userTrades.length === 0) return;

  // Fresh M15 for the pairs that need it (respecting the refresh interval).
  const pairsNeeded = new Set<PairCode>([
    ...trades.map((t) => t.pairCode as PairCode),
    ...userTrades.map((t) => t.prediction.pairCode as PairCode),
  ]);
  for (const pair of pairsNeeded) {
    if (LIVE_REFRESH_MS === 0) break;
    if (
      now.getTime() - (lastM15Refresh.get(pair) ?? 0) <
      LIVE_REFRESH_MS - 30_000
    )
      continue;
    lastM15Refresh.set(pair, now.getTime());
    await fetchTimeframeCandles(pair, 'M15', lastClosedStart).catch((error) =>
      console.warn(
        `M15 refresh failed for ${pair}.`,
        error instanceof Error ? error.message : error
      )
    );
  }

  // Closed candles only, oldest first, from the cache (no extra requests).
  const closedSeries = async (pair: PairCode, from: Date) => {
    for (const tf of ['M15', 'H1'] as const) {
      const span = CANDLE_MS[tf] ?? 3_600_000;
      const cached = await peekStale<Candle[]>(
        `twelvedata:tf:${pair}:${tf}`
      ).catch(() => null);
      if (!cached?.length) continue;
      const ordered = [...cached]
        .filter((c) => candleTime(c) + span <= now.getTime())
        .sort((x, y) => candleTime(x) - candleTime(y));
      if (!ordered.length || candleTime(ordered[0]) > from.getTime()) continue;
      return ordered.filter((c) => candleTime(c) + span > from.getTime());
    }
    return null;
  };

  // Engine trades: entry fills, targets and stops, announced as they happen.
  for (const row of trades) {
    const p = fromRow(row);
    const candles = await closedSeries(p.pairCode, row.validFrom);
    if (!candles) continue;
    const path = replayPath(p, candles);
    if (path.state === 'waiting' || path.state === 'neutral') continue;
    // Old news (e.g. the first run after a deploy) is logged, not alerted.
    const stale = (at: number | null) =>
      at !== null && now.getTime() - at > STALE_ALERT_MS;
    await announceSignalEvent(
      'ENTRY_FILLED',
      p,
      {},
      { silent: stale(path.filledAt) }
    ).catch(() => undefined);
    if (path.state === 'target' || path.state === 'stopped') {
      await announceSignalEvent(
        path.state === 'target' ? 'TARGET_HIT' : 'STOP_HIT',
        p,
        { pips: path.pips },
        { silent: stale(path.closedAt) }
      ).catch(() => undefined);
    }
  }

  // Users' own trades: exit detected at their stop or target.
  for (const trade of userTrades) {
    const p = fromRow(trade.prediction);
    const candles = await closedSeries(p.pairCode, trade.prediction.validFrom);
    if (!candles) continue;
    const long = trade.side === 'LONG';
    const entry =
      trade.entryPrice !== null
        ? Number(trade.entryPrice)
        : (p.entryLow + p.entryHigh) / 2;
    const stop =
      trade.stopPrice !== null
        ? Number(trade.stopPrice)
        : long
          ? -Infinity
          : Infinity;
    const target =
      trade.targetPrice !== null
        ? Number(trade.targetPrice)
        : long
          ? Infinity
          : -Infinity;
    const path = replayPath(
      {
        pairCode: p.pairCode,
        direction: trade.side,
        entryLow: entry,
        entryHigh: entry,
        targetPrice: target,
        invalidationPrice: stop,
      },
      candles
    );
    if (path.state !== 'target' && path.state !== 'stopped') continue;
    const reason = path.state === 'target' ? 'target' : 'stop';
    const exitPrice = reason === 'target' ? target : stop;
    await prisma.userTrade.update({
      where: { id: trade.id },
      data: {
        exitPrice,
        exitedAt: path.closedAt ? new Date(path.closedAt) : now,
        exitReason: reason,
      },
    });
    await announceMyTradeClosed(
      trade.userId,
      p,
      reason,
      exitPrice,
      path.pips
    ).catch(() => undefined);
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
  // The H1 checkpoint and the M15 tracker run on candle closes from the
  // per-minute loop (onCandleClose), not here.
  await evaluateExpiredPredictions(now);
  // Intraday signals only make sense while the market is tradeable.
  if (isForexOpen(now)) {
    await getOrCreatePredictions(now, options);
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
    prisma.prediction.count({ where: { continuesId: null } }),
    prisma.prediction.aggregate({
      where: { continuesId: null },
      _avg: { confidence: true },
    }),
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

  let openTrades = await getOpenTrades(now).catch(() => [] as Prediction[]);
  // A pair with no new signal but a trade carried by the latest analysis
  // shows that trade as its current signal (one trade, one card).
  const carried: Prediction[] = [];
  if (open) {
    for (const pair of pairs) {
      if (predictions.some((p) => p.pairCode === pair)) continue;
      const trade = openTrades.find((t) => t.pairCode === pair);
      if (!trade) continue;
      const event = await prisma.signalEvent.findFirst({
        where: {
          predictionId: Number(trade.id),
          kind: { startsWith: 'CARRY:' },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!event) continue;
      const [, key, verdict] = event.kind.split(':');
      const windowLabel = key?.endsWith('LONDON')
        ? 'London'
        : key?.endsWith('NEW_YORK')
          ? 'New York'
          : 'Asia';
      carried.push({
        ...trade,
        carried: {
          reconfirmed: verdict === 'SAME',
          window: windowLabel,
          at: event.createdAt.toISOString(),
        },
      });
    }
    openTrades = openTrades.filter((t) => !carried.some((c) => c.id === t.id));
  }
  const withLive = await Promise.all(
    predictions.map(async (p) => {
      // A hold shows the progress of the trade it is managing.
      if (p.continuesId) {
        const managed = openTrades.find((t) => t.id === p.continuesId);
        return { ...p, live: managed?.live ?? null };
      }
      if (
        p.outcome?.status === 'CANCELLED' ||
        p.outcome?.status === 'CLOSED_EARLY'
      )
        return { ...p, live: null };
      return { ...p, live: await liveProgress(p) };
    })
  );

  return {
    ...empty,
    marketStatus: open ? 'OPEN' : 'CLOSED',
    predictions: [...withLive, ...carried].sort((a, b) =>
      a.pairCode.localeCompare(b.pairCode)
    ),
    openTrades,
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
        ? nextWindowStart(now).toISOString()
        : nextMarketOpen(now).toISOString(),
    },
    liveDataEnabled: liveEnabled,
    dataAvailable,
  };
}
