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

// ---- Day-trade level construction ------------------------------------------

export interface DayTradeLevels {
  entryLow: number;
  entryHigh: number;
  targetPrice: number;
  invalidationPrice: number;
  stopPips: number;
  targetPips: number;
  riskReward: number;
  atrPips: number | null;
}

/**
 * Builds tradeable intraday levels from structure + volatility:
 * - entry zone anchored at the current price, sized ~0.25× ATR (clamped 6–30 pips);
 * - stop one ATR-fraction beyond structure (min 12 pips);
 * - target sized for R:R ≥ 1.5 (20–120 pips).
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
  const atrPips = atrValue !== null ? toPips(pair, atrValue) : 25;
  const zoneHalf = Math.min(Math.max(atrPips * 0.22, 4), 14) * pip;

  let entryLow = price - zoneHalf;
  let entryHigh = price + zoneHalf;

  const stopDist = Math.min(Math.max(atrPips * 0.55, 13), 70) * pip;
  const minTarget = 20 * pip;
  const maxTarget = 120 * pip;

  let targetPrice: number;
  let invalidationPrice: number;

  if (direction === 'LONG') {
    const structureStop =
      swingLow !== null
        ? Math.min(entryLow - 4 * pip, swingLow - 3 * pip)
        : entryLow - stopDist;
    invalidationPrice = Math.max(
      entryLow - 80 * pip,
      Math.min(entryLow - 12 * pip, structureStop, entryLow - stopDist)
    );
    const risk = Math.max(entryLow - invalidationPrice, 12 * pip);
    targetPrice = Math.min(
      entryHigh + maxTarget,
      Math.max(entryHigh + minTarget, entryHigh + risk * 1.8)
    );
  } else if (direction === 'SHORT') {
    const structureStop =
      swingHigh !== null
        ? Math.max(entryHigh + 4 * pip, swingHigh + 3 * pip)
        : entryHigh + stopDist;
    invalidationPrice = Math.min(
      entryHigh + 80 * pip,
      Math.max(entryHigh + 12 * pip, structureStop, entryHigh + stopDist)
    );
    const risk = Math.max(invalidationPrice - entryHigh, 12 * pip);
    targetPrice = Math.max(
      entryHigh - maxTarget,
      Math.min(entryHigh - minTarget, entryHigh - risk * 1.8)
    );
  } else {
    // NEUTRAL: bracket the range — target toward the nearer range edge expansion.
    invalidationPrice = entryLow - stopDist;
    targetPrice =
      entryHigh + Math.min(maxTarget, Math.max(minTarget, stopDist * 1.6));
  }

  entryLow = roundToPip(pair, entryLow);
  entryHigh = roundToPip(pair, entryHigh);
  targetPrice = roundToPip(pair, targetPrice);
  invalidationPrice = roundToPip(pair, invalidationPrice);

  const stopPips =
    direction === 'SHORT'
      ? toPips(pair, invalidationPrice - entryHigh)
      : toPips(pair, entryLow - invalidationPrice);
  const targetPips =
    direction === 'SHORT'
      ? toPips(pair, entryLow - targetPrice)
      : toPips(pair, targetPrice - entryHigh);
  const riskReward =
    stopPips > 0 ? Number((targetPips / stopPips).toFixed(2)) : 0;

  return {
    entryLow,
    entryHigh,
    targetPrice,
    invalidationPrice,
    stopPips: Number(stopPips.toFixed(1)),
    targetPips: Number(targetPips.toFixed(1)),
    riskReward,
    atrPips: atrValue !== null ? Number(atrPips.toFixed(1)) : null,
  };
}
