import type { PairCode } from './model.js';

/**
 * Market-hours + session utilities for a day-trader focused engine.
 *
 * Spot forex (EUR/USD, USD/JPY) trades Sunday 22:00 UTC → Friday 22:00 UTC.
 * Outside that window there is no intraday signal to publish — the product
 * switches to the weekend "next week" outlook instead.
 */

// ---- Market open / closed ---------------------------------------------------

/** True when spot forex is tradeable at `date` (Sun 22:00 UTC → Fri 22:00 UTC). */
export function isForexOpen(date = new Date()): boolean {
  const day = date.getUTCDay(); // 0 = Sunday … 6 = Saturday
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  if (day === 6) return false; // Saturday: fully closed
  if (day === 0 && hour < 22) return false; // Sunday before 22:00 UTC
  if (day === 5 && hour >= 22) return false; // Friday after 22:00 UTC
  return true;
}

/** Next moment the market opens (== `date` when already open). */
export function nextMarketOpen(date = new Date()): Date {
  if (isForexOpen(date)) return date;
  const next = new Date(date);
  // Walk forward in 15-minute steps (at most ~60h of weekend) to Sunday 22:00.
  for (let i = 0; i < 300; i += 1) {
    next.setUTCMinutes(next.getUTCMinutes() + 15);
    if (isForexOpen(next)) {
      next.setUTCMinutes(0, 0, 0);
      return next;
    }
  }
  return next;
}

/**
 * The Friday 22:00 UTC close that ends the trading week containing `date`
 * (or the next one, when called during the weekend).
 */
export function nextMarketClose(date = new Date()): Date {
  const close = new Date(date);
  const daysUntilFriday = (5 - close.getUTCDay() + 7) % 7;
  close.setUTCDate(close.getUTCDate() + daysUntilFriday);
  close.setUTCHours(22, 0, 0, 0);
  if (close <= date) close.setUTCDate(close.getUTCDate() + 7);
  return close;
}

// ---- Sessions + day-trader killzones ----------------------------------------

export type KillzoneId =
  'asia-range' | 'london-kz' | 'london-ny-overlap' | 'ny-kz' | 'off-hours';

export interface SessionInfo {
  /** Display session, mirrors model.getSession(). */
  session: string;
  killzone: KillzoneId;
  killzoneLabel: string;
  /** Short day-trader guidance for the current window. */
  playbookHint: string;
  /** True inside the two high-liquidity killzones day traders care about. */
  inKillzone: boolean;
}

export function sessionInfo(date = new Date()): SessionInfo {
  const h = date.getUTCHours() + date.getUTCMinutes() / 60;
  // Killzones in UTC: London KZ 07–10, NY KZ 12–15 (first hours of each cash flow).
  if (h >= 7 && h < 10)
    return {
      session: 'London',
      killzone: 'london-kz',
      killzoneLabel: 'London killzone',
      playbookHint:
        'London killzone — trade the break of the Asia range, not the middle of it.',
      inKillzone: true,
    };
  if (h >= 12 && h < 15)
    return {
      session: 'London / New York',
      killzone: 'ny-kz',
      killzoneLabel: 'New York killzone',
      playbookHint:
        'New York killzone — morning momentum usually sets the day; avoid chasing after 15:00 UTC.',
      inKillzone: true,
    };
  if (h >= 0 && h < 7)
    return {
      session: 'Tokyo',
      killzone: 'asia-range',
      killzoneLabel: 'Asia range',
      playbookHint:
        'Asia range — expect mean-reversion; mark the high/low for the London break.',
      inKillzone: false,
    };
  if (h >= 10 && h < 12)
    return {
      session: 'London',
      killzone: 'london-ny-overlap',
      killzoneLabel: 'Late London morning',
      playbookHint:
        'Late London morning — continuation of the killzone move or patience into New York.',
      inKillzone: false,
    };
  if (h >= 15 && h < 22)
    return {
      session: 'New York',
      killzone: 'ny-kz',
      killzoneLabel: 'New York afternoon',
      playbookHint:
        'New York afternoon — manage open risk; new entries only on clean retests.',
      inKillzone: false,
    };
  return {
    session: 'Asia pre-open',
    killzone: 'off-hours',
    killzoneLabel: 'Off hours',
    playbookHint: 'Off hours — spreads widen; plan, do not chase.',
    inKillzone: false,
  };
}

// ---- Week keys for the weekend outlook -------------------------------------

/** ISO week key (e.g. "2026-W40") for the week containing `date`. */
export function weekKeyFor(date = new Date()): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7
  );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * The trading week an instant belongs to. Spot FX reopens Sunday 22:00 UTC,
 * but ISO weeks start on Monday, so a Sunday instant is moved to the Monday
 * after it — otherwise the Sunday open (and the whole weekend outlook) would
 * be filed under the week that just ended.
 */
export function tradingWeekAnchor(date: Date): Date {
  if (date.getUTCDay() !== 0) return date;
  const monday = new Date(date);
  monday.setUTCDate(monday.getUTCDate() + 1);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

/** Monday 00:00 UTC → Friday 22:00 UTC bounds for the week containing `date`. */
export function weekBounds(date = new Date()): {
  weekStart: Date;
  weekEnd: Date;
} {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  const dayNum = d.getUTCDay() || 7;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - (dayNum - 1));
  monday.setUTCHours(0, 0, 0, 0);
  const friday = new Date(monday);
  friday.setUTCDate(monday.getUTCDate() + 4);
  friday.setUTCHours(22, 0, 0, 0);
  return { weekStart: monday, weekEnd: friday };
}

// ---- Pair helpers -----------------------------------------------------------

export const PAIRS: PairCode[] = ['EUR/USD', 'USD/JPY'];

export function pipSize(pair: PairCode): number {
  return pair === 'EUR/USD' ? 0.0001 : 0.01;
}

export function decimals(pair: PairCode): number {
  return pair === 'EUR/USD' ? 5 : 3;
}

export function toPips(pair: PairCode, priceDistance: number): number {
  return Math.abs(priceDistance) / pipSize(pair);
}

export function roundToPip(pair: PairCode, value: number): number {
  return Number(value.toFixed(decimals(pair)));
}

// ---- Signal windows (session-aligned) ---------------------------------------
//
// Signals are published at the session opens rather than on a fixed 6-hour
// clock. London and New York carry the edge; Asia is a lighter read (only
// fully aligned setups). Nothing new is published 17:00–24:00 UTC, when
// liquidity thins out; trades already open are still followed to target or
// stop.

export type WindowId = 'ASIA' | 'LONDON' | 'NEW_YORK';

export interface TradingWindow {
  id: WindowId;
  /** Label stored on signals (also the session filter value). */
  label: 'Asia' | 'London' | 'New York';
  start: Date;
  end: Date;
  /** Unique per day + window, e.g. "2026-10-06-LONDON". */
  key: string;
  /** Re-checks after a target or stop are allowed in this window. */
  rearm: boolean;
  /** Lighter read: publish only fully aligned setups. */
  strict: boolean;
}

export const WINDOW_SCHEDULE: {
  id: WindowId;
  label: TradingWindow['label'];
  startHour: number;
  endHour: number;
  rearm: boolean;
  strict: boolean;
}[] = [
  {
    id: 'ASIA',
    label: 'Asia',
    startHour: 0,
    endHour: 7,
    rearm: false,
    strict: true,
  },
  {
    id: 'LONDON',
    label: 'London',
    startHour: 7,
    endHour: 12,
    rearm: true,
    strict: false,
  },
  {
    id: 'NEW_YORK',
    label: 'New York',
    startHour: 12,
    endHour: 17,
    rearm: true,
    strict: false,
  },
];

/** The signal window `date` falls in, or null (17:00–24:00 UTC, or market closed). */
export function tradingWindowAt(date = new Date()): TradingWindow | null {
  if (!isForexOpen(date)) return null;
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  const slot = WINDOW_SCHEDULE.find(
    (w) => hour >= w.startHour && hour < w.endHour
  );
  if (!slot) return null;
  const day = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  const start = new Date(day.getTime() + slot.startHour * 3_600_000);
  const end = new Date(day.getTime() + slot.endHour * 3_600_000);
  return {
    id: slot.id,
    label: slot.label,
    start,
    end,
    key: `${day.toISOString().slice(0, 10)}-${slot.id}`,
    rearm: slot.rearm,
    strict: slot.strict,
  };
}

/** Start of the next signal window after `date` (skips evenings and weekends). */
export function nextWindowStart(date = new Date()): Date {
  const probe = new Date(date);
  probe.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 24 * 4; i += 1) {
    probe.setUTCHours(probe.getUTCHours() + 1);
    const w = tradingWindowAt(probe);
    if (w && w.start.getTime() === probe.getTime() && probe > date)
      return new Date(probe);
  }
  return nextMarketOpen(date);
}
