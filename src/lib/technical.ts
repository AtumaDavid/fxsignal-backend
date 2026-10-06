import { decimals, pipSize, roundToPip, toPips } from './market.js';
import type { PairCode, Direction } from './model.js';

export interface Candle {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Timeframe = 'MONTHLY' | 'WEEKLY' | 'DAILY' | 'H4' | 'H1' | 'M15';

export interface TimeframeView {
  timeframe: Timeframe;
  price: number;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  atr: number | null;
  atrPips: number | null;
  swingHigh: number | null;
  swingLow: number | null;
  changePct: number;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  biasScore: number; // -100 … +100
  summary: string;
}

// ---- Indicators -------------------------------------------------------------

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function last<T>(arr: (T | null)[]): T | null {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (arr[i] !== null && arr[i] !== undefined) return arr[i] as T;
  }
  return null;
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function swings(
  candles: Candle[],
  lookback = 20
): { high: number | null; low: number | null } {
  const window = candles.slice(-lookback);
  if (window.length === 0) return { high: null, low: null };
  return {
    high: Math.max(...window.map((c) => c.high)),
    low: Math.min(...window.map((c) => c.low)),
  };
}

// ---- Per-timeframe bias -----------------------------------------------------

function scoreBias(parts: number[]): number {
  return Math.max(
    -100,
    Math.min(100, Math.round(parts.reduce((a, b) => a + b, 0)))
  );
}

export function analyzeTimeframe(
  pair: PairCode,
  timeframe: Timeframe,
  candlesOldestFirst: Candle[]
): TimeframeView | null {
  const candles = [...candlesOldestFirst].reverse(); // newest-first from provider → oldest-first
  const closes = candles.map((c) => c.close);
  if (closes.length < 5) return null;
  const price = closes[closes.length - 1];
  const prev = closes.length > 1 ? closes[closes.length - 2] : price;

  const e20 = last(ema(closes, 20));
  const e50 = last(ema(closes, 50));
  const e200 = last(ema(closes, 200));
  const r = rsi(closes, 14);
  const a = atr(candles, 14);
  const { high, low } = swings(candles, 20);

  const parts: number[] = [];
  if (e20 !== null) parts.push(price > e20 ? 22 : -22);
  if (e20 !== null && e50 !== null) parts.push(e20 > e50 ? 18 : -18);
  if (e50 !== null && e200 !== null) parts.push(e50 > e200 ? 14 : -14);
  else if (e50 !== null) parts.push(price > e50 ? 10 : -10);
  if (r !== null) {
    if (r >= 55) parts.push(Math.min(16, Math.round((r - 50) * 1.6)));
    else if (r <= 45) parts.push(-Math.min(16, Math.round((50 - r) * 1.6)));
  }
  // Position inside the recent range: near highs is bullish, near lows bearish.
  if (high !== null && low !== null && high > low) {
    const pos = (price - low) / (high - low);
    parts.push(Math.round((pos - 0.5) * 20));
  }
  const biasScore = scoreBias(parts);
  const bias =
    biasScore >= 15 ? 'BULLISH' : biasScore <= -15 ? 'BEARISH' : 'NEUTRAL';
  const changePct = prev ? ((price - prev) / prev) * 100 : 0;

  const bits: string[] = [];
  bits.push(`price ${price.toFixed(decimals(pair) - 1)}`);
  if (e20 !== null && e50 !== null)
    bits.push(price > e20 ? 'above EMA20' : 'below EMA20');
  if (e20 !== null && e50 !== null)
    bits.push(e20 > e50 ? 'EMA20>EMA50' : 'EMA20<EMA50');
  if (r !== null) bits.push(`RSI ${r.toFixed(0)}`);
  if (a !== null) bits.push(`ATR ${toPips(pair, a).toFixed(1)} pips`);

  return {
    timeframe,
    price,
    ema20: e20,
    ema50: e50,
    ema200: e200,
    rsi14: r,
    atr: a,
    atrPips: a !== null ? toPips(pair, a) : null,
    swingHigh: high,
    swingLow: low,
    changePct,
    bias,
    biasScore,
    summary: `${timeframe}: ${bias.toLowerCase()} (${biasScore}) — ${bits.join(', ')}.`,
  };
}

export interface Confluence {
  direction: Direction;
  /** -100 … +100 aligned score. */
  score: number;
  /** 0–100 confidence derived from alignment + momentum + catalyst penalty. */
  confidence: number;
  views: TimeframeView[];
  /** Human-readable per-timeframe votes, highest timeframe first. */
  votes: {
    timeframe: Timeframe;
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    score: number;
  }[];
  notes: string[];
  /** Intraday model only: H1 clearly agrees with the daily/H4 context. */
  h1Aligned?: boolean;
}

/**
 * Multi-timeframe confluence, monthly → down.
 * Higher timeframes dominate: weights MONTHLY 30 / WEEKLY 25 / DAILY 20 /
 * H4 12 / H1 8 / M15 5. A catalyst penalty is applied by the caller.
 */
export function confluence(
  views: TimeframeView[],
  catalystPenalty = 0
): Confluence | null {
  if (views.length === 0) return null;
  const weights: Record<Timeframe, number> = {
    MONTHLY: 30,
    WEEKLY: 25,
    DAILY: 20,
    H4: 12,
    H1: 8,
    M15: 5,
  };
  let weighted = 0;
  let total = 0;
  const votes = views.map((v) => {
    const w = weights[v.timeframe] ?? 5;
    weighted += v.biasScore * w;
    total += w * 100;
    return { timeframe: v.timeframe, bias: v.bias, score: v.biasScore };
  });
  const score = total === 0 ? 0 : Math.round((weighted / total) * 100);
  const direction: Direction =
    score >= 12 ? 'LONG' : score <= -12 ? 'SHORT' : 'NEUTRAL';

  // Agreement: how many timeframe votes agree with the dominant direction?
  const agree = views.filter((v) =>
    direction === 'LONG'
      ? v.bias === 'BULLISH'
      : direction === 'SHORT'
        ? v.bias === 'BEARISH'
        : v.bias === 'NEUTRAL'
  ).length;
  const agreement = views.length === 0 ? 0 : agree / views.length;

  // Momentum kicker from the fast timeframes (what day traders actually trade).
  const fast = views.filter(
    (v) => v.timeframe === 'H1' || v.timeframe === 'M15'
  );
  const fastScore =
    fast.length === 0
      ? 0
      : fast.reduce((a, v) => a + v.biasScore, 0) / fast.length;

  let confidence =
    42 +
    agreement * 30 +
    Math.min(12, Math.abs(score) / 10) +
    Math.min(6, Math.abs(fastScore) / 18);
  confidence -= catalystPenalty;
  // Against-trend intraday trades get a haircut: HTF trend vs fast momentum clash.
  const slow = views.filter(
    (v) => v.timeframe === 'DAILY' || v.timeframe === 'WEEKLY'
  );
  const slowScore =
    slow.length === 0
      ? 0
      : slow.reduce((a, v) => a + v.biasScore, 0) / slow.length;
  if (
    Math.sign(score) !== 0 &&
    Math.sign(fastScore) !== 0 &&
    Math.sign(score) !== Math.sign(fastScore)
  )
    confidence -= 8;
  void slowScore;
  confidence = Math.max(15, Math.min(92, Math.round(confidence)));

  const notes: string[] = [];
  const byTf = (tf: Timeframe) => views.find((v) => v.timeframe === tf);
  const monthly = byTf('MONTHLY');
  const weekly = byTf('WEEKLY');
  const daily = byTf('DAILY');
  const h1 = byTf('H1');
  if (monthly && weekly)
    notes.push(
      monthly.bias === weekly.bias
        ? `Higher timeframes agree ${monthly.bias.toLowerCase()} (monthly + weekly).`
        : `Higher-timeframe tension: monthly ${monthly.bias.toLowerCase()} vs weekly ${weekly.bias.toLowerCase()} — size down.`
    );
  if (daily)
    notes.push(
      daily.bias === 'NEUTRAL'
        ? 'Daily is range-bound — intraday levels matter more than chasing.'
        : `Daily trend is ${daily.bias.toLowerCase()} — intraday dips/rips in that direction are the A-trade.`
    );
  if (h1 && h1.rsi14 !== null && (h1.rsi14 >= 70 || h1.rsi14 <= 30))
    notes.push(
      h1.rsi14 >= 70
        ? 'H1 RSI is overbought — avoid fresh longs into highs; wait for a pullback.'
        : 'H1 RSI is oversold — avoid fresh shorts into lows; wait for a bounce.'
    );
  if (catalystPenalty > 0)
    notes.push('High-impact catalyst risk — confidence reduced.');

  return { direction, score, confidence, views, votes, notes };
}

// ---- Intraday model: context → execution → confirmation -----------------
//
// Daily and H4 set the direction (context). H1 is the execution timeframe:
// it must not point against the context, and its volatility and structure
// place the levels. M15 only confirms (or questions) the timing.

/** Context weights: the daily trend leads, H4 refines. */
const CONTEXT_WEIGHTS: Partial<Record<Timeframe, number>> = {
  DAILY: 0.55,
  H4: 0.45,
};
const DIRECTION_THRESHOLD = 15;

export function intradayConfluence(
  views: TimeframeView[],
  catalystPenalty = 0
): Confluence | null {
  const byTf = (tf: Timeframe) => views.find((v) => v.timeframe === tf);
  const daily = byTf('DAILY');
  const h4 = byTf('H4');
  const h1 = byTf('H1');
  const m15 = byTf('M15');
  const context = [daily, h4].filter((v): v is TimeframeView => Boolean(v));
  if (context.length === 0 || !h1) return null;

  // Weighted context score, renormalised if one of the two is missing.
  const weightSum = context.reduce(
    (a, v) => a + (CONTEXT_WEIGHTS[v.timeframe] ?? 0),
    0
  );
  const score = Math.round(
    context.reduce(
      (a, v) => a + v.biasScore * (CONTEXT_WEIGHTS[v.timeframe] ?? 0),
      0
    ) / weightSum
  );
  let direction: Direction =
    score >= DIRECTION_THRESHOLD
      ? 'LONG'
      : score <= -DIRECTION_THRESHOLD
        ? 'SHORT'
        : 'NEUTRAL';
  const sign = direction === 'LONG' ? 1 : direction === 'SHORT' ? -1 : 0;
  const agrees = (v?: TimeframeView) =>
    Boolean(v) &&
    sign !== 0 &&
    Math.sign(v!.biasScore) === sign &&
    Math.abs(v!.biasScore) >= DIRECTION_THRESHOLD;
  const opposes = (v?: TimeframeView) =>
    Boolean(v) &&
    sign !== 0 &&
    Math.sign(v!.biasScore) === -sign &&
    Math.abs(v!.biasScore) >= DIRECTION_THRESHOLD;

  const notes: string[] = [];
  const contextAligned = Boolean(daily && h4) && agrees(daily) && agrees(h4);
  if (daily && h4) {
    notes.push(
      daily.bias === h4.bias
        ? `Context: daily and H4 both ${daily.bias.toLowerCase()}.`
        : `Context split: daily ${daily.bias.toLowerCase()} vs H4 ${h4.bias.toLowerCase()} — size down.`
    );
  }

  // Execution gate: never execute against the context on H1.
  const h1Opposes = opposes(h1);
  if (h1Opposes) {
    notes.push(
      `H1 is ${h1.bias.toLowerCase()} against the ${direction === 'LONG' ? 'bullish' : 'bearish'} context — stand aside until H1 realigns.`
    );
    direction = 'NEUTRAL';
  } else if (sign !== 0) {
    notes.push(
      agrees(h1)
        ? 'H1 execution aligned with the context.'
        : 'H1 is flat — wait for an H1 push in the context direction before executing.'
    );
  }

  // Confirmation: M15 adjusts confidence; it never sets direction.
  const m15Confirms = agrees(m15);
  const m15Against = opposes(m15);
  if (direction !== 'NEUTRAL' && m15) {
    notes.push(
      m15Confirms
        ? 'M15 confirms: momentum already in the trade direction.'
        : m15Against
          ? 'M15 not confirmed: wait for an M15 close back in the trade direction.'
          : 'M15 neutral: wait for an M15 close in the trade direction.'
    );
  }
  if (h1.rsi14 !== null && (h1.rsi14 >= 70 || h1.rsi14 <= 30)) {
    notes.push(
      h1.rsi14 >= 70
        ? 'H1 RSI overbought — avoid chasing longs; prefer a pullback into the zone.'
        : 'H1 RSI oversold — avoid chasing shorts; prefer a bounce into the zone.'
    );
  }
  if (catalystPenalty > 0)
    notes.push('High-impact catalyst in the window — confidence reduced.');

  let confidence =
    40 +
    Math.min(22, Math.abs(score) * 0.3) +
    (contextAligned ? 10 : 0) +
    (agrees(h1) ? 10 : h1Opposes ? -10 : 0) +
    (m15Confirms ? 6 : m15Against ? -6 : 0) -
    catalystPenalty;
  if (direction === 'NEUTRAL') confidence = Math.min(confidence, 45);
  confidence = Math.max(15, Math.min(92, Math.round(confidence)));

  const order: Timeframe[] = ['DAILY', 'H4', 'H1', 'M15'];
  const ordered = order
    .map((tf) => byTf(tf))
    .filter((v): v is TimeframeView => Boolean(v));
  return {
    direction,
    score,
    confidence,
    views: ordered,
    votes: ordered.map((v) => ({
      timeframe: v.timeframe,
      bias: v.bias,
      score: v.biasScore,
    })),
    notes,
    h1Aligned: direction !== 'NEUTRAL' && agrees(h1),
  };
}

// ---- Day-trade level construction ------------------------------------------

/** Minimum reward:risk for every published signal, measured from the zone midpoint. */
export const MIN_REWARD_RISK = 2;
/** Largest stop (from the zone midpoint) that still leaves room for 2R inside the target cap. */
export const MAX_RISK_PIPS = 60;
export const MAX_TARGET_PIPS = 120;

export interface DayTradeLevels {
  entryLow: number;
  entryHigh: number;
  targetPrice: number;
  invalidationPrice: number;
  stopPips: number;
  targetPips: number;
  riskReward: number;
  atrPips: number | null;
  /** False when the H1 structure needs a stop too wide for 1:2 inside the target cap. */
  tradeable: boolean;
  /** Why the setup is not tradeable, when it isn't. */
  reason: string | null;
}

/** Stop/target pips and R from the middle of the zone. */
function measure(
  pair: PairCode,
  l: {
    entryLow: number;
    entryHigh: number;
    targetPrice: number;
    invalidationPrice: number;
  }
) {
  const mid = (l.entryLow + l.entryHigh) / 2;
  const stopPips = Number(toPips(pair, mid - l.invalidationPrice).toFixed(1));
  const targetPips = Number(toPips(pair, l.targetPrice - mid).toFixed(1));
  return {
    stopPips,
    targetPips,
    riskReward: stopPips > 0 ? Number((targetPips / stopPips).toFixed(2)) : 0,
  };
}

/**
 * H1 execution levels:
 * - entry zone centred on the current price, sized from H1 ATR (8–28 pips wide);
 * - invalidation beyond the recent H1 swing (+3 pips), at least 12 pips past
 *   the near edge of the zone;
 * - target at exactly MIN_REWARD_RISK × the risk, both measured from the zone
 *   midpoint (rounded outward, so it never falls below 2R).
 * If the structural stop is wider than MAX_RISK_PIPS, a 2R target would not
 * fit in one window, so the setup is reported as not tradeable rather than
 * squeezed into a worse ratio.
 */
export function buildDayTradeLevels(
  pair: PairCode,
  direction: Direction,
  price: number,
  atrValue: number | null,
  swingHigh: number | null,
  swingLow: number | null
): DayTradeLevels {
  const pip = pipSize(pair);
  const atrPips = atrValue !== null ? toPips(pair, atrValue) : 20;
  const zoneHalf = Math.min(Math.max(atrPips * 0.22, 4), 14) * pip;
  const entryLow = roundToPip(pair, price - zoneHalf);
  const entryHigh = roundToPip(pair, price + zoneHalf);
  const mid = (entryLow + entryHigh) / 2;
  const atrStop = Math.min(Math.max(atrPips * 0.6, 12), MAX_RISK_PIPS) * pip;

  let invalidationPrice: number;
  let targetPrice: number;
  let reason: string | null = null;

  if (direction === 'LONG' || direction === 'SHORT') {
    const long = direction === 'LONG';
    const nearEdge = long ? entryLow : entryHigh;
    const minStop = long ? nearEdge - 12 * pip : nearEdge + 12 * pip;
    const structure =
      long && swingLow !== null
        ? swingLow - 3 * pip
        : !long && swingHigh !== null
          ? swingHigh + 3 * pip
          : long
            ? mid - atrStop
            : mid + atrStop;
    // Beyond structure and at least 12 pips past the zone.
    invalidationPrice = long
      ? Math.min(structure, minStop)
      : Math.max(structure, minStop);
    const riskPips = toPips(pair, mid - invalidationPrice);
    if (riskPips > MAX_RISK_PIPS) {
      reason = `The H1 stop would be ${riskPips.toFixed(0)} pips beyond structure — too wide for 1:${MIN_REWARD_RISK} inside one window.`;
    }
    invalidationPrice = roundToPip(pair, invalidationPrice);
    const risk = Math.abs(mid - invalidationPrice);
    const rewardDistance = Math.max(risk * MIN_REWARD_RISK, 20 * pip);
    // Round the target outward so rounding can never cost reward.
    const rawTarget = long ? mid + rewardDistance : mid - rewardDistance;
    targetPrice = roundToPip(
      pair,
      long
        ? Math.ceil(rawTarget / pip - 1e-9) * pip
        : Math.floor(rawTarget / pip + 1e-9) * pip
    );
  } else {
    // NEUTRAL: no trade; keep reference levels one ATR stop either side.
    invalidationPrice = roundToPip(pair, mid - atrStop);
    targetPrice = roundToPip(pair, mid + atrStop * MIN_REWARD_RISK);
  }

  const m = measure(pair, {
    entryLow,
    entryHigh,
    targetPrice,
    invalidationPrice,
  });
  return {
    entryLow,
    entryHigh,
    targetPrice,
    invalidationPrice,
    ...m,
    atrPips: atrValue !== null ? Number(atrPips.toFixed(1)) : null,
    tradeable: reason === null,
    reason,
  };
}

/**
 * Enforces MIN_REWARD_RISK on externally supplied levels (the model review):
 * pushes the target out to 2R from the zone midpoint when it is closer.
 * Returns null when 2R cannot fit inside the target cap, so the caller can
 * fall back to engine-built levels instead of publishing a worse ratio.
 */
export function enforceMinRewardRisk<
  T extends {
    pairCode: PairCode;
    direction: Direction;
    entryLow: number;
    entryHigh: number;
    targetPrice: number;
    invalidationPrice: number;
  },
>(levels: T): T | null {
  if (levels.direction === 'NEUTRAL') return levels;
  const pair = levels.pairCode;
  const pip = pipSize(pair);
  const long = levels.direction === 'LONG';
  const mid = (levels.entryLow + levels.entryHigh) / 2;
  const risk = long
    ? mid - levels.invalidationPrice
    : levels.invalidationPrice - mid;
  if (risk <= 0 || toPips(pair, risk) > MAX_RISK_PIPS) return null;
  const minReward = risk * MIN_REWARD_RISK;
  const reward = long ? levels.targetPrice - mid : mid - levels.targetPrice;
  if (reward >= minReward - 1e-9) return levels;
  const raw = long ? mid + minReward : mid - minReward;
  const targetPrice = roundToPip(
    pair,
    long
      ? Math.ceil(raw / pip - 1e-9) * pip
      : Math.floor(raw / pip + 1e-9) * pip
  );
  if (toPips(pair, Math.abs(targetPrice - mid)) > MAX_TARGET_PIPS + 15)
    return null;
  return { ...levels, targetPrice };
}
