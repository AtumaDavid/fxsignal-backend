import { z } from 'zod';
import type { PairCode, Direction } from './model.js';
import type { LiveMarketEvent } from './liveData.js';
import type { Confluence, TimeframeView } from './technical.js';

export interface AiPredictionAnalysis {
  pairCode: PairCode;
  direction: Direction;
  confidence: number;
  entryLow: number;
  entryHigh: number;
  targetPrice: number;
  invalidationPrice: number;
  rationale: string;
  factors: string[];
}

/** 1 pip per pair in price terms (EUR/USD 0.0001, USD/JPY 0.01). */
const PIP_SIZE: Record<PairCode, number> = {
  'EUR/USD': 0.0001,
  'USD/JPY': 0.01,
};

// Deterministic guard-rails applied AFTER parsing, so the model can never
// publish degenerate levels (a 1-2 pip entry zone, a target inside the entry
// zone, an invalidation immediately next to it). Distances are in pips.
const MIN_ENTRY_ZONE_PIPS = 6;
const MAX_ENTRY_ZONE_PIPS = 30;
const MIN_TARGET_DISTANCE_PIPS = 20;
const MAX_TARGET_DISTANCE_PIPS = 120;
const MIN_INVALIDATION_DISTANCE_PIPS = 12;
const MAX_INVALIDATION_DISTANCE_PIPS = 80;

interface LevelSet {
  pairCode: PairCode;
  direction: Direction;
  entryLow: number;
  entryHigh: number;
  targetPrice: number;
  invalidationPrice: number;
}

/**
 * Guarantees a tradeable signal regardless of what the model returned:
 * - the entry zone is at least 6 pips (and at most 30) wide;
 * - the target sits at least 20 pips beyond the FAR edge of the entry zone in
 *   the direction of the trade (a LONG target is above entryHigh, a SHORT
 *   target below entryLow, never inside the zone);
 * - the invalidation sits at least 12 pips beyond the NEAR edge, opposite the
 *   trade.
 * Idempotent: sane levels pass through unchanged.
 */
export function normalizeLevels<T extends LevelSet>(prediction: T): T {
  const pip = PIP_SIZE[prediction.pairCode];
  const roundToPip = (value: number) =>
    Number(value.toFixed(prediction.pairCode === 'EUR/USD' ? 5 : 3));

  let entryLow = roundToPip(prediction.entryLow);
  let entryHigh = roundToPip(prediction.entryHigh);
  let targetPrice = roundToPip(prediction.targetPrice);
  let invalidationPrice = roundToPip(prediction.invalidationPrice);

  if (entryLow > entryHigh) {
    [entryLow, entryHigh] = [entryHigh, entryLow];
  }

  // Expand (or shrink) an unrealistic entry zone symmetrically about its
  // midpoint so it stays inside a sane width band.
  const minZone = MIN_ENTRY_ZONE_PIPS * pip;
  const maxZone = MAX_ENTRY_ZONE_PIPS * pip;
  const zoneWidth = entryHigh - entryLow;
  if (zoneWidth < minZone || zoneWidth > maxZone) {
    const mid = (entryLow + entryHigh) / 2;
    const half = Math.min(Math.max(zoneWidth, minZone), maxZone) / 2;
    entryLow = roundToPip(mid - half);
    entryHigh = roundToPip(mid + half);
  }

  const minTarget = MIN_TARGET_DISTANCE_PIPS * pip;
  const maxTarget = MAX_TARGET_DISTANCE_PIPS * pip;
  const minInvalidation = MIN_INVALIDATION_DISTANCE_PIPS * pip;
  const maxInvalidation = MAX_INVALIDATION_DISTANCE_PIPS * pip;

  if (prediction.direction === 'LONG') {
    targetPrice = Math.min(
      Math.max(targetPrice, entryHigh + minTarget),
      entryHigh + maxTarget
    );
    invalidationPrice = Math.max(
      Math.min(invalidationPrice, entryLow - minInvalidation),
      entryLow - maxInvalidation
    );
  } else if (prediction.direction === 'SHORT') {
    targetPrice = Math.max(
      Math.min(targetPrice, entryLow - minTarget),
      entryLow - maxTarget
    );
    invalidationPrice = Math.min(
      Math.max(invalidationPrice, entryHigh + minInvalidation),
      entryHigh + maxInvalidation
    );
  } else {
    // NEUTRAL: no directional bias — keep both levels a clear distance out.
    targetPrice =
      targetPrice >= entryHigh
        ? Math.min(
            Math.max(targetPrice, entryHigh + minTarget),
            entryHigh + maxTarget
          )
        : Math.max(
            Math.min(targetPrice, entryLow - minTarget),
            entryLow - maxTarget
          );
    invalidationPrice =
      invalidationPrice <= entryLow
        ? Math.max(
            Math.min(invalidationPrice, entryLow - minInvalidation),
            entryLow - maxInvalidation
          )
        : Math.min(
            Math.max(invalidationPrice, entryHigh + minInvalidation),
            entryHigh + maxInvalidation
          );
  }

  return {
    ...prediction,
    entryLow: roundToPip(entryLow),
    entryHigh: roundToPip(entryHigh),
    targetPrice: roundToPip(targetPrice),
    invalidationPrice: roundToPip(invalidationPrice),
  };
}

class EmptyAnalysisError extends Error {}

// This analysis is a reasoning-model workload: it spends around a minute on
// chain-of-thought before the first character of the answer appears. Two
// consequences drive the settings below.
//
// 1. The response is streamed. A ~70s non-streaming request is dropped
//    mid-flight (ECONNRESET) because nothing crosses the socket while the model
//    thinks; streaming keeps bytes flowing and the connection alive.
// 2. The token budget covers reasoning *and* the answer. At 4_000 the model
//    used the whole budget thinking and the JSON came back truncated
//    (finish_reason=length), so every attempt failed to parse.
const REQUEST_TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS ?? 150_000);
const MAX_TOKENS = Number(process.env.DEEPSEEK_MAX_TOKENS ?? 12_000);

async function callDeepSeek(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: MAX_TOKENS,
      response_format: { type: 'json_object' },
      stream: true,
      messages,
    }),
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `DeepSeek returned ${response.status}: ${detail.slice(0, 200)}`
    );
  }

  let content = '';
  let finishReason = 'unknown';
  let sawReasoning = false;
  let buffer = '';
  const decoder = new TextDecoder();

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let event: {
        choices?: Array<{
          delta?: { content?: string; reasoning_content?: string };
          finish_reason?: string | null;
        }>;
        error?: { message?: string };
      };
      try {
        event = JSON.parse(payload);
      } catch {
        continue; // Ignore keep-alive/partial frames.
      }
      if (event.error)
        throw new Error(event.error.message ?? 'DeepSeek stream error.');
      const choice = event.choices?.[0];
      if (choice?.delta?.content) content += choice.delta.content;
      if (choice?.delta?.reasoning_content) sawReasoning = true;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  }

  const trimmed = content.trim();
  if (!trimmed || finishReason === 'length') {
    const diagnostic = [
      `model=${model}`,
      `finish=${finishReason}`,
      `chars=${trimmed.length}`,
      `reasoning=${sawReasoning}`,
      `max_tokens=${MAX_TOKENS}`,
    ].join(' ');
    throw new EmptyAnalysisError(
      finishReason === 'length'
        ? `DeepSeek ran out of tokens before finishing the JSON (${diagnostic}). Raise DEEPSEEK_MAX_TOKENS.`
        : `DeepSeek returned an empty analysis (${diagnostic}).`
    );
  }
  return trimmed;
}

// ---- v2: multi-timeframe day-trader analysis --------------------------------

export interface MtfPairContext {
  pairCode: PairCode;
  price: number;
  confluence: Confluence;
  session: string;
  killzoneHint: string;
}

const intradaySchema = z.object({
  predictions: z
    .array(
      z.object({
        pairCode: z.enum(['EUR/USD', 'USD/JPY']),
        direction: z.enum(['LONG', 'SHORT', 'NEUTRAL']),
        confidence: z.number().min(0).max(100),
        entryLow: z.number(),
        entryHigh: z.number(),
        targetPrice: z.number(),
        invalidationPrice: z.number(),
        rationale: z.string().min(1).max(600),
        factors: z.array(z.string()).min(1).max(6),
        playbook: z.string().min(1).max(600).optional(),
      })
    )
    .min(1)
    .max(2),
});

export interface IntradayAiResult extends AiPredictionAnalysis {
  playbook: string | null;
}

function compactMtfContext(
  pairs: MtfPairContext[],
  events: LiveMarketEvent[]
): string {
  return JSON.stringify({
    asOf: new Date().toISOString(),
    style:
      'intraday: daily+H4 context, H1 execution, M15 confirmation, min 2R, 6-hour window',
    pairs: pairs.map((p) => ({
      pairCode: p.pairCode,
      currentPrice: p.price,
      session: p.session,
      killzoneHint: p.killzoneHint,
      deterministicConfluence: {
        direction:
          p.confluence.direction === 'LONG'
            ? 'LONG'
            : p.confluence.direction === 'SHORT'
              ? 'SHORT'
              : 'NEUTRAL',
        score: p.confluence.score,
        confidence: p.confluence.confidence,
        votes: p.confluence.votes,
        notes: p.confluence.notes,
      },
      timeframes: p.confluence.views.map((v: TimeframeView) => ({
        tf: v.timeframe,
        price: v.price,
        bias: v.bias,
        score: v.biasScore,
        ema20: v.ema20,
        ema50: v.ema50,
        ema200: v.ema200,
        rsi14: v.rsi14 === null ? null : Number(v.rsi14.toFixed(1)),
        atrPips: v.atrPips,
        swingHigh: v.swingHigh,
        swingLow: v.swingLow,
      })),
    })),
    upcomingEvents: events.slice(0, 20).map((event) => ({
      currency: event.currency,
      title: event.title,
      eventDate: event.eventDate.toISOString(),
      impact: event.impact,
      forecast: event.forecast,
      previousValue: event.previousValue,
    })),
  });
}

/**
 * Day-trader intraday analysis over multi-timeframe context. The deterministic
 * confluence (computed server-side from real indicators) is supplied as the
 * anchor — the model refines direction/confidence/levels and writes the
 * session playbook, but cannot hallucinate structure from raw candles.
 */
export async function requestIntradayAnalysis(
  pairs: MtfPairContext[],
  events: LiveMarketEvent[]
): Promise<IntradayAiResult[]> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not configured.');
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  const messages = [
    {
      role: 'system',
      content:
        'You are a disciplined FX day-trading desk analyst for EUR/USD and USD/JPY. The trading model is fixed: the DAILY and H4 timeframes set the context (direction); H1 is the execution timeframe (entry zone, stop beyond the recent H1 swing); M15 is confirmation only (it can raise or lower confidence, never set direction). Respect the supplied deterministic confluence, which is computed from real EMA/RSI/ATR/structure on exactly those timeframes. You may keep its direction or downgrade to NEUTRAL (for example when event risk is high); never flip it, and never trade when it is NEUTRAL. Return JSON only with a predictions array (one object per pair). Never promise profits, never invent news; confidence is an integer 15-92 representing signal confidence, not win probability. Levels must be realistic spot FX (EUR/USD pip 0.0001, USD/JPY pip 0.01): entry zone 8-28 pips wide around the current price; stop beyond the recent H1 structure, 12-60 pips from the middle of the zone; target measured from the middle of the zone at AT LEAST 2x the stop distance (reward:risk >= 2.0, never less). Also include a 1-2 sentence session playbook: execute on H1 inside the zone, wait for an M15 close in the trade direction, what invalidates, and when to stand aside.',
    },
    {
      role: 'user',
      content: `Return JSON with this shape: {"predictions":[{"pairCode":"EUR/USD","direction":"LONG|SHORT|NEUTRAL","confidence":0,"entryLow":0,"entryHigh":0,"targetPrice":0,"invalidationPrice":0,"rationale":"...","factors":["..."],"playbook":"..."},{"pairCode":"USD/JPY",...}]}\n\nMarket context:\n${compactMtfContext(pairs, events)}`,
    },
  ];

  let lastEmptyError: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const content = await callDeepSeek(apiKey, model, messages);
      const parsed = intradaySchema.parse(JSON.parse(content));
      return parsed.predictions.map((prediction) => ({
        ...normalizeLevels({
          ...prediction,
          confidence: Math.round(
            prediction.confidence <= 1
              ? prediction.confidence * 100
              : prediction.confidence
          ),
        }),
        playbook: prediction.playbook ?? null,
      }));
    } catch (error) {
      if (error instanceof EmptyAnalysisError && attempt === 1) {
        lastEmptyError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastEmptyError ?? new Error('DeepSeek intraday analysis failed.');
}

// ---- v2: weekend weekly outlook ---------------------------------------------

const weeklySchema = z.object({
  outlooks: z
    .array(
      z.object({
        pairCode: z.enum(['EUR/USD', 'USD/JPY']),
        bias: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
        confidence: z.number().min(0).max(100),
        headline: z.string().min(1).max(160),
        narrative: z.string().min(1).max(2000),
        supports: z.array(z.number()).max(6).default([]),
        resistances: z.array(z.number()).max(6).default([]),
        bullTrigger: z.string().min(1).max(400),
        bullTarget: z.number(),
        baseTrigger: z.string().min(1).max(400),
        baseTarget: z.number(),
        bearTrigger: z.string().min(1).max(400),
        bearTarget: z.number(),
        catalysts: z.array(z.string()).min(1).max(8),
        tradingPlan: z.string().min(1).max(1200),
      })
    )
    .min(1)
    .max(2),
});

export interface WeeklyAiOutlook {
  pairCode: PairCode;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidence: number;
  headline: string;
  narrative: string;
  supports: number[];
  resistances: number[];
  bullTrigger: string;
  bullTarget: number;
  baseTrigger: string;
  baseTarget: number;
  bearTrigger: string;
  bearTarget: number;
  catalysts: string[];
  tradingPlan: string;
}

/**
 * Weekend analysis for the coming week, built top-down: monthly → weekly →
 * daily → H4 → H1. Only higher timeframes are sent (no scalping noise) plus
 * the week-ahead macro calendar.
 */
export async function requestWeeklyAnalysis(
  pairs: MtfPairContext[],
  weekEvents: LiveMarketEvent[],
  weekLabel: string
): Promise<WeeklyAiOutlook[]> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not configured.');
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  const context = JSON.stringify({
    week: weekLabel,
    style: 'weekly swing/day-trading preparation, top-down monthly to H1',
    pairs: pairs.map((p) => ({
      pairCode: p.pairCode,
      currentPrice: p.price,
      deterministicConfluence: {
        direction: p.confluence.direction,
        score: p.confluence.score,
        confidence: p.confluence.confidence,
        votes: p.confluence.votes,
        notes: p.confluence.notes,
      },
      timeframes: p.confluence.views
        .filter((v: TimeframeView) =>
          ['MONTHLY', 'WEEKLY', 'DAILY', 'H4', 'H1'].includes(v.timeframe)
        )
        .map((v: TimeframeView) => ({
          tf: v.timeframe,
          price: v.price,
          bias: v.bias,
          score: v.biasScore,
          ema20: v.ema20,
          ema50: v.ema50,
          ema200: v.ema200,
          rsi14: v.rsi14 === null ? null : Number(v.rsi14.toFixed(1)),
          atrPips: v.atrPips,
          swingHigh: v.swingHigh,
          swingLow: v.swingLow,
        })),
    })),
    weekEvents: weekEvents.slice(0, 30).map((event) => ({
      currency: event.currency,
      title: event.title,
      eventDate: event.eventDate.toISOString(),
      impact: event.impact,
      forecast: event.forecast,
      previousValue: event.previousValue,
    })),
  });
  const messages = [
    {
      role: 'system',
      content:
        'You are a senior FX strategist writing the weekend preparation for day traders on EUR/USD and USD/JPY. Work strictly top-down (monthly → weekly → daily → H4 → H1) from the supplied indicator context; respect the deterministic confluence votes. Return JSON only with an outlooks array (one per pair). Bias must be BULLISH/BEARISH/NEUTRAL with integer confidence 15-92. Narrative (3-6 sentences) must walk through the higher timeframes first, then what must hold intraday. Key levels must be realistic spot prices near the current price. Scenarios: bull/base/bear each with a trigger condition and a price target. Catalysts: the tradable events of the week. Trading plan: 2-4 sentences telling a day trader which sessions/killzones to focus on, where to be patient, and what invalidates the week. Never promise profits, never invent news events.',
    },
    {
      role: 'user',
      content: `Return JSON with this shape: {"outlooks":[{"pairCode":"EUR/USD","bias":"BULLISH|BEARISH|NEUTRAL","confidence":0,"headline":"...","narrative":"...","supports":[0],"resistances":[0],"bullTrigger":"...","bullTarget":0,"baseTrigger":"...","baseTarget":0,"bearTrigger":"...","bearTarget":0,"catalysts":["..."],"tradingPlan":"..."}]}\n\nWeek context:\n${context}`,
    },
  ];

  let lastEmptyError: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const content = await callDeepSeek(apiKey, model, messages);
      const parsed = weeklySchema.parse(JSON.parse(content));
      return parsed.outlooks.map((o) => ({
        ...o,
        confidence: Math.round(
          o.confidence <= 1 ? o.confidence * 100 : o.confidence
        ),
      }));
    } catch (error) {
      if (error instanceof EmptyAnalysisError && attempt === 1) {
        lastEmptyError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastEmptyError ?? new Error('DeepSeek weekly analysis failed.');
}
