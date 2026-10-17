import { candleTime } from './liveData.js';
import { pipSize, roundToPip, toPips } from './market.js';
import type { Direction, PairCode } from './model.js';
import { atr, type Candle, type Timeframe } from './technical.js';

// ---- Price zones: where a trade may happen ------------------------------------
//
// Each timeframe has one job. Weekly / Daily / H4 mark the areas that matter
// (previous day and week highs/lows, confirmed pivots, demand/supply bases);
// H1 adds order blocks that refine the entry inside them; the Asia range
// marks the session. M15 never creates a zone — it only confirms the entry
// (see EntryTrigger).
//
// Support/resistance, demand/supply and order blocks are different names for
// price areas, not independent votes: overlapping sources merge into one zone
// that is scored once, so the same area is never counted three times.

export type ZoneTimeframe = Exclude<Timeframe, 'MONTHLY' | 'M15'> | 'SESSION';

export type ZoneSourceKind =
  | 'PREV_DAY_HIGH'
  | 'PREV_DAY_LOW'
  | 'PREV_WEEK_HIGH'
  | 'PREV_WEEK_LOW'
  | 'ASIA_HIGH'
  | 'ASIA_LOW'
  | 'PIVOT_HIGH'
  | 'PIVOT_LOW'
  | 'DEMAND'
  | 'SUPPLY'
  | 'BULLISH_OB'
  | 'BEARISH_OB';

export interface ZoneSource {
  timeframe: ZoneTimeframe;
  kind: ZoneSourceKind;
  low: number;
  high: number;
  /** Demand/supply and order blocks: not traded back into since they formed. */
  fresh?: boolean;
  /** Order blocks: the displacement left a fair-value gap. */
  imbalance?: boolean;
}

export interface Zone {
  low: number;
  high: number;
  sources: ZoneSource[];
  /** Highest timeframe weight + a little for each other timeframe (see scoreZone). */
  score: number;
  /** Contains a Weekly, Daily or H4 source: strong enough to trade from or to block a target. */
  higherTimeframe: boolean;
  /** e.g. "Daily support + H4 demand + H1 bullish order block". */
  label: string;
}

const SPAN: Record<Timeframe, number> = {
  MONTHLY: 30 * 86_400_000,
  WEEKLY: 7 * 86_400_000,
  DAILY: 86_400_000,
  H4: 4 * 3_600_000,
  H1: 3_600_000,
  M15: 15 * 60_000,
};

const TF_WEIGHT: Record<ZoneTimeframe, number> = {
  WEEKLY: 4,
  DAILY: 3,
  H4: 2,
  H1: 1,
  SESSION: 1,
};

const TF_LABEL: Record<ZoneTimeframe, string> = {
  WEEKLY: 'Weekly',
  DAILY: 'Daily',
  H4: 'H4',
  H1: 'H1',
  SESSION: 'Asia',
};

/** Fractal pivot strength (bars each side) and how far back to look. */
const PIVOT: Partial<Record<Timeframe, { side: number; bars: number }>> = {
  DAILY: { side: 2, bars: 120 },
  H4: { side: 3, bars: 180 },
};
/** Pivots kept per side and timeframe, newest first. */
const PIVOTS_KEPT = 6;
/** Displacement: the move away from the base, in that timeframe's ATR, within DISPLACEMENT_BARS. */
const DISPLACEMENT_ATR = 1.5;
const DISPLACEMENT_BARS = 3;
/** A base candle's body is at most this share of its range, and its range at most one ATR. */
const BASE_BODY_SHARE = 0.5;
/** Demand/supply and order blocks traded back into this often are spent. */
const MAX_MITIGATIONS = 2;

/** Closed candles only, oldest first (input is newest first, as the provider returns it). */
export function closedCandles(
  newestFirst: Candle[] | undefined,
  tf: Timeframe,
  now: number
): Candle[] {
  return [...(newestFirst ?? [])]
    .filter((c) => candleTime(c) + SPAN[tf] <= now)
    .sort((a, b) => candleTime(a) - candleTime(b));
}

/** A single price level widened into a thin band from its timeframe's ATR. */
function band(
  pair: PairCode,
  price: number,
  atrValue: number | null
): { low: number; high: number } {
  const pip = pipSize(pair);
  const half = Math.min(Math.max((atrValue ?? 0) * 0.08, 2 * pip), 8 * pip);
  return { low: price - half, high: price + half };
}

/** Previous day, previous week (built from daily candles) and the Asia range. */
function sessionLevels(
  pair: PairCode,
  daily: Candle[],
  m15: Candle[],
  now: number
): ZoneSource[] {
  const out: ZoneSource[] = [];
  const dailyAtr = atr(daily, 14);
  const level = (
    timeframe: ZoneTimeframe,
    kind: ZoneSourceKind,
    price: number
  ) => out.push({ timeframe, kind, ...band(pair, price, dailyAtr) });

  const today = Math.floor(now / 86_400_000) * 86_400_000;
  const prevDay = [...daily].reverse().find((c) => candleTime(c) < today);
  if (prevDay) {
    level('DAILY', 'PREV_DAY_HIGH', prevDay.high);
    level('DAILY', 'PREV_DAY_LOW', prevDay.low);
  }

  // Weeks start Monday; a Sunday-evening open belongs to the week after it.
  const weekOf = (t: number) => {
    const d = new Date(t);
    const shift = d.getUTCDay() === 0 ? 1 : 1 - (d.getUTCDay() || 7);
    return Math.floor(t / 86_400_000) * 86_400_000 + shift * 86_400_000;
  };
  const thisWeek = weekOf(now);
  const lastWeek = daily.filter(
    (c) => weekOf(candleTime(c)) === thisWeek - 7 * 86_400_000
  );
  if (lastWeek.length > 0) {
    level('WEEKLY', 'PREV_WEEK_HIGH', Math.max(...lastWeek.map((c) => c.high)));
    level('WEEKLY', 'PREV_WEEK_LOW', Math.min(...lastWeek.map((c) => c.low)));
  }

  // Asia range: 00–07 UTC today, once it is complete.
  const asiaEnd = today + 7 * 3_600_000;
  if (now >= asiaEnd) {
    const asia = m15.filter((c) => {
      const t = candleTime(c);
      return t >= today && t < asiaEnd;
    });
    if (asia.length >= 20) {
      const m15Atr = atr(m15, 14);
      out.push({
        timeframe: 'SESSION',
        kind: 'ASIA_HIGH',
        ...band(pair, Math.max(...asia.map((c) => c.high)), m15Atr),
      });
      out.push({
        timeframe: 'SESSION',
        kind: 'ASIA_LOW',
        ...band(pair, Math.min(...asia.map((c) => c.low)), m15Atr),
      });
    }
  }
  return out;
}

/** Confirmed fractal pivots: the extreme of `side` bars on each side. */
export function pivots(
  candles: Candle[],
  side: number
): { highs: { index: number; price: number }[]; lows: { index: number; price: number }[] } {
  const highs: { index: number; price: number }[] = [];
  const lows: { index: number; price: number }[] = [];
  for (let i = side; i < candles.length - side; i += 1) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - side; j <= i + side; j += 1) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high });
    if (isLow) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}

function pivotLevels(
  pair: PairCode,
  tf: 'DAILY' | 'H4',
  candles: Candle[]
): ZoneSource[] {
  const cfg = PIVOT[tf]!;
  const recent = candles.slice(-cfg.bars);
  const a = atr(recent, 14);
  const { highs, lows } = pivots(recent, cfg.side);
  return [
    ...highs.slice(-PIVOTS_KEPT).map((p) => ({
      timeframe: tf,
      kind: 'PIVOT_HIGH' as const,
      ...band(pair, p.price, a),
    })),
    ...lows.slice(-PIVOTS_KEPT).map((p) => ({
      timeframe: tf,
      kind: 'PIVOT_LOW' as const,
      ...band(pair, p.price, a),
    })),
  ];
}

/**
 * One detector for demand/supply (Daily, H4) and order blocks (H1): a base
 * candle followed by a displacement of at least DISPLACEMENT_ATR × ATR within
 * DISPLACEMENT_BARS that closes beyond the base.
 * - Demand/supply: the base is a small-bodied candle (indecision before the move).
 * - Order block: the base is the last opposite-coloured candle, and the move
 *   must also break structure (close beyond the latest confirmed H1 pivot).
 * A zone is dropped once a later candle closes through its far edge, or once
 * price has traded back into it more than MAX_MITIGATIONS times.
 */
export function displacementZones(
  tf: 'DAILY' | 'H4' | 'H1',
  candles: Candle[],
  orderBlocks: boolean
): ZoneSource[] {
  const a = atr(candles, 14);
  if (a === null || candles.length < 20) return [];
  const structure = orderBlocks ? pivots(candles, 3) : null;
  const out: ZoneSource[] = [];

  for (let i = 1; i < candles.length - 1; i += 1) {
    const base = candles[i];
    const range = base.high - base.low;
    const body = Math.abs(base.close - base.open);
    for (const bullish of [true, false]) {
      if (orderBlocks) {
        // Last opposing candle: bearish before a bullish move, and vice versa.
        if (bullish ? base.close >= base.open : base.close <= base.open)
          continue;
        const next = candles[i + 1];
        if (bullish ? next.close <= next.open : next.close >= next.open)
          continue;
      } else if (range <= 0 || body > range * BASE_BODY_SHARE || range > a) {
        continue;
      }

      // Displacement away from the base.
      let end = -1;
      for (let k = 1; k <= DISPLACEMENT_BARS && i + k < candles.length; k += 1) {
        const c = candles[i + k];
        const move = bullish ? c.close - base.high : base.low - c.close;
        if (move >= DISPLACEMENT_ATR * a) {
          end = i + k;
          break;
        }
      }
      if (end < 0) continue;

      let imbalance = false;
      if (orderBlocks) {
        // Break of structure: the move closes beyond the last pivot before the base.
        const prior = (bullish ? structure!.highs : structure!.lows).filter(
          (p) => p.index + 3 < i
        );
        const last = prior[prior.length - 1];
        if (!last) continue;
        const broke = candles
          .slice(i + 1, end + 1)
          .some((c) => (bullish ? c.close > last.price : c.close < last.price));
        if (!broke) continue;
        for (let j = i + 1; j < end && j + 1 < candles.length; j += 1) {
          if (
            bullish
              ? candles[j + 1].low > candles[j - 1].high
              : candles[j + 1].high < candles[j - 1].low
          )
            imbalance = true;
        }
      }

      // Zone: base low → body top for demand (mirrored for supply); the full
      // candle for order blocks.
      const low = bullish || orderBlocks ? base.low : Math.min(base.open, base.close);
      const high = !bullish || orderBlocks ? base.high : Math.max(base.open, base.close);

      let mitigations = 0;
      let broken = false;
      let inside = false;
      for (let j = end + 1; j < candles.length; j += 1) {
        const c = candles[j];
        if (bullish ? c.close < low : c.close > high) {
          broken = true;
          break;
        }
        const touches = bullish ? c.low <= high : c.high >= low;
        if (touches && !inside) mitigations += 1;
        inside = touches;
      }
      if (broken || mitigations > MAX_MITIGATIONS) continue;

      out.push({
        timeframe: tf,
        kind: orderBlocks
          ? bullish
            ? 'BULLISH_OB'
            : 'BEARISH_OB'
          : bullish
            ? 'DEMAND'
            : 'SUPPLY',
        low,
        high,
        fresh: mitigations === 0,
        imbalance,
      });
    }
  }
  return out;
}

const ROLE: Record<ZoneSourceKind, 'support' | 'resistance' | 'either'> = {
  PREV_DAY_HIGH: 'either',
  PREV_DAY_LOW: 'either',
  PREV_WEEK_HIGH: 'either',
  PREV_WEEK_LOW: 'either',
  ASIA_HIGH: 'either',
  ASIA_LOW: 'either',
  PIVOT_HIGH: 'either',
  PIVOT_LOW: 'either',
  DEMAND: 'support',
  SUPPLY: 'resistance',
  BULLISH_OB: 'support',
  BEARISH_OB: 'resistance',
};

function sourceLabel(s: ZoneSource, role: 'support' | 'resistance'): string {
  const tf = TF_LABEL[s.timeframe];
  switch (s.kind) {
    case 'PREV_DAY_HIGH':
      return 'previous-day high';
    case 'PREV_DAY_LOW':
      return 'previous-day low';
    case 'PREV_WEEK_HIGH':
      return 'previous-week high';
    case 'PREV_WEEK_LOW':
      return 'previous-week low';
    case 'ASIA_HIGH':
      return 'Asia high';
    case 'ASIA_LOW':
      return 'Asia low';
    case 'PIVOT_HIGH':
    case 'PIVOT_LOW':
      return `${tf} ${role}`;
    case 'DEMAND':
      return `${tf} demand`;
    case 'SUPPLY':
      return `${tf} supply`;
    case 'BULLISH_OB':
      return `${tf} bullish order block`;
    case 'BEARISH_OB':
      return `${tf} bearish order block`;
  }
}

/**
 * One score per merged area: the strongest timeframe's weight, +0.5 for each
 * other timeframe (at most +1.5), +0.5 when a demand/supply or order block in
 * it is fresh, +0.25 for an imbalance, +0.5 for equal highs/lows (two pivots
 * of one timeframe in the same place).
 */
function scoreZone(sources: ZoneSource[]): number {
  const tfs = [...new Set(sources.map((s) => s.timeframe))];
  const top = Math.max(...tfs.map((tf) => TF_WEIGHT[tf]));
  let score = top + Math.min(1.5, 0.5 * (tfs.length - 1));
  if (sources.some((s) => s.fresh)) score += 0.5;
  if (sources.some((s) => s.imbalance)) score += 0.25;
  const pivotTfs = sources
    .filter((s) => s.kind === 'PIVOT_HIGH' || s.kind === 'PIVOT_LOW')
    .map((s) => s.timeframe);
  if (pivotTfs.length !== new Set(pivotTfs).size) score += 0.5;
  return Number(score.toFixed(2));
}

function makeZone(sources: ZoneSource[], price: number): Zone {
  const low = Math.min(...sources.map((s) => s.low));
  const high = Math.max(...sources.map((s) => s.high));
  const role = (low + high) / 2 <= price ? 'support' : 'resistance';
  const labels: string[] = [];
  const ordered = [...sources].sort(
    (a, b) => TF_WEIGHT[b.timeframe] - TF_WEIGHT[a.timeframe]
  );
  for (const s of ordered) {
    const l = sourceLabel(s, role);
    if (!labels.includes(l)) labels.push(l);
  }
  const label = labels.join(' + ');
  return {
    low,
    high,
    sources,
    score: scoreZone(sources),
    higherTimeframe: sources.some((s) => TF_WEIGHT[s.timeframe] >= 2),
    label: label.charAt(0).toUpperCase() + label.slice(1),
  };
}

/**
 * Merges overlapping sources into zones. A merge that would make a zone wider
 * than `maxWidth` starts a new zone instead, so chains of nearby levels do not
 * grow into one meaningless band.
 */
export function mergeZones(
  sources: ZoneSource[],
  price: number,
  maxWidth: number
): Zone[] {
  const sorted = [...sources].sort((a, b) => a.low - b.low);
  const groups: ZoneSource[][] = [];
  let cur: ZoneSource[] = [];
  let curHigh = -Infinity;
  let curLow = Infinity;
  for (const s of sorted) {
    if (
      cur.length > 0 &&
      s.low <= curHigh &&
      Math.max(curHigh, s.high) - Math.min(curLow, s.low) <= maxWidth
    ) {
      cur.push(s);
      curHigh = Math.max(curHigh, s.high);
      curLow = Math.min(curLow, s.low);
      continue;
    }
    if (cur.length > 0) groups.push(cur);
    cur = [s];
    curHigh = s.high;
    curLow = s.low;
  }
  if (cur.length > 0) groups.push(cur);
  return groups.map((g) => makeZone(g, price));
}

export interface ZoneMap {
  zones: Zone[];
  price: number;
}

/**
 * Every zone for a pair from the candles closed by `now` (inputs newest
 * first, as fetched). Monthly is context only and not used here; M15 only
 * supplies the Asia range.
 */
export interface ZoneSourceSet {
  /** Previous day/week highs and lows, Asia range. */
  sessionLevels?: boolean;
  /** Daily and H4 fractal pivots. */
  pivots?: boolean;
  /** Daily and H4 demand/supply. */
  demandSupply?: boolean;
  /** H1 order blocks. */
  orderBlocks?: boolean;
}

export function buildZoneMap(
  pair: PairCode,
  mtf: Partial<Record<Timeframe, Candle[]>>,
  price: number,
  now: number,
  include: ZoneSourceSet = {}
): ZoneMap {
  const use = { sessionLevels: true, pivots: true, demandSupply: true, orderBlocks: true, ...include };
  const daily = closedCandles(mtf.DAILY, 'DAILY', now);
  const h4 = closedCandles(mtf.H4, 'H4', now);
  const h1 = closedCandles(mtf.H1, 'H1', now);
  const m15 = closedCandles(mtf.M15, 'M15', now);

  const sources: ZoneSource[] = [
    ...(use.sessionLevels ? sessionLevels(pair, daily, m15, now) : []),
    ...(use.pivots && daily.length >= 20 ? pivotLevels(pair, 'DAILY', daily) : []),
    ...(use.pivots && h4.length >= 20 ? pivotLevels(pair, 'H4', h4) : []),
    ...(use.demandSupply ? displacementZones('DAILY', daily.slice(-120), false) : []),
    ...(use.demandSupply ? displacementZones('H4', h4.slice(-180), false) : []),
    ...(use.orderBlocks ? displacementZones('H1', h1.slice(-120), true) : []),
  ];
  const dailyAtr = atr(daily, 14);
  const maxWidth = Math.max(30 * pipSize(pair), (dailyAtr ?? 0) * 0.5);
  return { zones: mergeZones(sources, price, maxWidth), price };
}

// ---- Trade plan from the zones ---------------------------------------------------

/** Entry zone width bounds (the published zone; the guard-rails allow 6–30). */
const MIN_ENTRY_PIPS = 8;
const MAX_ENTRY_PIPS = 28;
/** Stop beyond the zone's far edge, and never closer than this to the entry. */
const STOP_BUFFER_PIPS = 3;
const MIN_STOP_PIPS = 12;

export interface ZonePlan {
  entryLow: number;
  entryHigh: number;
  invalidationPrice: number;
  targetPrice: number;
  zone: Zone;
  /** H1 order block that set the entry inside the zone, if any. */
  orderBlock: ZoneSource | null;
  /** Nearest higher-timeframe zone against the trade (caps the target). */
  opposing: Zone | null;
}

export type ZonePlanResult =
  | { ok: true; plan: ZonePlan }
  | { ok: false; reason: string; code: 'NO_ZONE' | 'NO_ROOM' | 'STOP_TOO_WIDE' };

/**
 * Where to trade, given the direction from the daily/H4 context:
 * 1. the best higher-timeframe zone on the trade's side of price (support
 *    for a long, resistance for a short), at or within `reach` of the price;
 * 2. the entry is an H1 order block inside that zone when there is one,
 *    otherwise the zone's near edge (8–28 pips);
 * 3. the stop sits beyond the zone's far edge;
 * 4. TP2 is `minR` × the risk, and the nearest higher-timeframe zone against
 *    the trade must not sit in front of it — otherwise there is no trade.
 */
export function planZoneTrade(
  pair: PairCode,
  direction: Direction,
  map: ZoneMap,
  options: {
    reach: number;
    minR: number;
    maxRiskPips: number;
    /** Volatility floor for the stop, measured from the entry midpoint. */
    minRisk?: number;
    /** Reject the trade when an opposing zone sits before the target (default true). */
    requireRoom?: boolean;
    /** Round-trip cost; the target is pushed out so minR holds after it. */
    costPips?: number;
  }
): ZonePlanResult {
  if (direction === 'NEUTRAL') return { ok: false, reason: 'No direction.', code: 'NO_ZONE' };
  const pip = pipSize(pair);
  const long = direction === 'LONG';
  const { price } = map;
  const supportive = (z: Zone) =>
    z.sources.some((s) => ROLE[s.kind] !== (long ? 'resistance' : 'support'));

  const candidates = map.zones.filter(
    (z) =>
      z.higherTimeframe &&
      supportive(z) &&
      (long
        ? z.low < price && z.high >= price - options.reach
        : z.high > price && z.low <= price + options.reach)
  );
  if (candidates.length === 0)
    return {
      ok: false,
      code: 'NO_ZONE',
      reason: `No higher-timeframe ${long ? 'support/demand' : 'resistance/supply'} zone within reach of price — no location to trade from.`,
    };
  // Strongest first; the nearer one breaks a tie.
  const distance = (z: Zone) =>
    long ? Math.max(0, price - z.high) : Math.max(0, z.low - price);
  candidates.sort((a, b) => b.score - a.score || distance(a) - distance(b));
  const zone = candidates[0];

  // Entry: an H1 order block in the zone, else the zone's near edge.
  const ob =
    zone.sources
      .filter(
        (s) => s.timeframe === 'H1' && s.kind === (long ? 'BULLISH_OB' : 'BEARISH_OB')
      )
      .sort((a, b) => (long ? b.high - a.high : a.low - b.low))[0] ?? null;
  let entryLow: number;
  let entryHigh: number;
  if (ob) {
    entryLow = Math.max(ob.low, zone.low);
    entryHigh = Math.min(ob.high, zone.high);
  } else if (long) {
    entryHigh = zone.high;
    entryLow = Math.max(zone.low, zone.high - MAX_ENTRY_PIPS * pip);
  } else {
    entryLow = zone.low;
    entryHigh = Math.min(zone.high, zone.low + MAX_ENTRY_PIPS * pip);
  }
  // Inside the width bounds, keeping the near edge where it is.
  if (entryHigh - entryLow > MAX_ENTRY_PIPS * pip) {
    if (long) entryLow = entryHigh - MAX_ENTRY_PIPS * pip;
    else entryHigh = entryLow + MAX_ENTRY_PIPS * pip;
  }
  if (entryHigh - entryLow < MIN_ENTRY_PIPS * pip) {
    const pad = (MIN_ENTRY_PIPS * pip - (entryHigh - entryLow)) / 2;
    entryLow -= pad;
    entryHigh += pad;
  }
  entryLow = roundToPip(pair, entryLow);
  entryHigh = roundToPip(pair, entryHigh);
  const mid = (entryLow + entryHigh) / 2;

  // Stop beyond the far edge of the whole zone, never inside normal H1 noise.
  const floor = options.minRisk ?? 0;
  const invalidationPrice = roundToPip(
    pair,
    long
      ? Math.min(zone.low - STOP_BUFFER_PIPS * pip, entryLow - MIN_STOP_PIPS * pip, mid - floor)
      : Math.max(zone.high + STOP_BUFFER_PIPS * pip, entryHigh + MIN_STOP_PIPS * pip, mid + floor)
  );
  const risk = Math.abs(mid - invalidationPrice);
  const riskPips = toPips(pair, risk);
  if (riskPips > options.maxRiskPips)
    return {
      ok: false,
      code: 'STOP_TOO_WIDE',
      reason: `${zone.label} needs a ${riskPips.toFixed(0)}-pip stop beyond it — too wide for 1:${options.minR} inside one window.`,
    };

  const reward = risk * options.minR + costAllowance(pair, options.minR, options.costPips);
  const rawTarget = long ? mid + reward : mid - reward;
  const targetPrice = roundToPip(
    pair,
    long
      ? Math.ceil(rawTarget / pip - 1e-9) * pip
      : Math.floor(rawTarget / pip + 1e-9) * pip
  );

  const room = roomCheck(pair, direction, map, { entryLow, entryHigh, targetPrice }, zone);
  if (!room.ok && options.requireRoom !== false) return room;
  const opposing = room.ok ? room.opposing : null;

  return {
    ok: true,
    plan: { entryLow, entryHigh, invalidationPrice, targetPrice, zone, orderBlock: ob, opposing },
  };
}

/**
 * Extra target distance so `minR` holds after a round-trip cost c:
 * (reward − c) ≥ minR × (risk + c) ⇔ reward ≥ minR × risk + (minR + 1) × c.
 */
export function costAllowance(pair: PairCode, minR: number, costPips = 0) {
  return (minR + 1) * costPips * pipSize(pair);
}

/** Clear space kept between the target and the next opposing zone. */
export const ROOM_BUFFER_PIPS = 5;

/**
 * The nearest higher-timeframe zone against the trade beyond the entry, and
 * whether it leaves room for the target plus ROOM_BUFFER_PIPS: a long whose
 * next resistance sits before that (or a short whose next support does) is
 * not taken.
 */
export function roomCheck(
  pair: PairCode,
  direction: 'LONG' | 'SHORT',
  map: ZoneMap,
  levels: { entryLow: number; entryHigh: number; targetPrice: number },
  exclude?: Zone
):
  | { ok: true; opposing: Zone | null }
  | { ok: false; reason: string; code: 'NO_ROOM' } {
  const long = direction === 'LONG';
  const opposing =
    map.zones
      .filter(
        (z) =>
          z !== exclude &&
          z.higherTimeframe &&
          z.sources.some(
            (s) => ROLE[s.kind] !== (long ? 'support' : 'resistance')
          ) &&
          (long ? z.low > levels.entryHigh : z.high < levels.entryLow)
      )
      .sort((a, b) => (long ? a.low - b.low : b.high - a.high))[0] ?? null;
  const buffer = ROOM_BUFFER_PIPS * pipSize(pair);
  if (
    opposing &&
    (long
      ? opposing.low < levels.targetPrice + buffer
      : opposing.high > levels.targetPrice - buffer)
  ) {
    const mid = (levels.entryLow + levels.entryHigh) / 2;
    const room = toPips(pair, long ? opposing.low - mid : mid - opposing.high);
    return {
      ok: false,
      code: 'NO_ROOM',
      reason: `${opposing.label} sits ${room.toFixed(0)} pips from the entry — no room for the target before it.`,
    };
  }
  return { ok: true, opposing };
}

/** Plain-text "1.0842–1.0856" for a zone. */
export function zoneRange(pair: PairCode, z: { low: number; high: number }) {
  return `${roundToPip(pair, z.low)}–${roundToPip(pair, z.high)}`;
}
