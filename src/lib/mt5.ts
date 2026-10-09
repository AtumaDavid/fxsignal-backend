import type { PairCode } from './model.js';

/**
 * MT5 read-only sync: positions reported by the FXSignal Sync EA are matched
 * to the signal they followed and written to the user's journal.
 */

export interface Mt5Position {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  /** Unix seconds, UTC (the EA converts from broker server time). */
  openTime: number;
  openPrice: number;
  volume: number;
  sl: number;
  tp: number;
  closedVolume: number;
  closePrice?: number;
  closeTime?: number;
  profit?: number;
}

/** Broker symbol → FXSignal pair: "EURUSDm", "EURUSD.raw", "EUR/USD" → "EUR/USD". */
export function pairFromSymbol(symbol: string): PairCode | null {
  const letters = symbol.toUpperCase().replace(/[^A-Z]/g, '');
  if (letters.startsWith('EURUSD')) return 'EUR/USD';
  if (letters.startsWith('USDJPY')) return 'USD/JPY';
  return null;
}

export interface SignalWindow {
  id: number;
  pairCode: string;
  direction: string;
  validFrom: Date;
  expiresAt: Date;
}

/** Positions opened shortly before a signal (clock skew) still count. */
const EARLY_MS = 5 * 60_000;
/** A late entry after the window still belongs to that window's signal. */
const LATE_MS = 60 * 60_000;

/**
 * The signal a position followed: same pair and direction, opened between
 * the signal's publication and shortly after its window ended. The newest
 * such signal wins (a re-check replaces an earlier call).
 */
export function matchSignal(
  position: Mt5Position,
  signals: SignalWindow[]
): SignalWindow | null {
  const pair = pairFromSymbol(position.symbol);
  if (!pair) return null;
  const direction = position.side === 'BUY' ? 'LONG' : 'SHORT';
  const opened = position.openTime * 1000;
  const candidates = signals.filter(
    (s) =>
      s.pairCode === pair &&
      s.direction === direction &&
      opened >= s.validFrom.getTime() - EARLY_MS &&
      opened <= s.expiresAt.getTime() + LATE_MS
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) =>
    a.validFrom.getTime() >= b.validFrom.getTime() ? a : b
  );
}

export interface JournalFill {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number | null;
  lots: number;
  stopPrice: number | null;
  targetPrice: number | null;
  openedAt: Date;
  exitedAt: Date | null;
  externalRef: string;
}

const EPS = 1e-6;

/**
 * Several positions on one signal (e.g. one per take-profit) become one
 * journal trade: volume-weighted entry and exit, total lots, the tightest
 * stop and the furthest target. It counts as closed only when every
 * position is fully closed.
 */
export function aggregatePositions(positions: Mt5Position[]): JournalFill {
  const long = positions[0].side === 'BUY';
  const volume = positions.reduce((s, p) => s + p.volume, 0);
  const entry =
    positions.reduce((s, p) => s + p.openPrice * p.volume, 0) / volume;
  const closedVolume = positions.reduce((s, p) => s + p.closedVolume, 0);
  const allClosed = positions.every(
    (p) => p.closedVolume >= p.volume - EPS && p.closePrice
  );
  const exit = allClosed
    ? positions.reduce((s, p) => s + (p.closePrice ?? 0) * p.closedVolume, 0) /
      closedVolume
    : null;
  const stops = positions.map((p) => p.sl).filter((v) => v > 0);
  const targets = positions.map((p) => p.tp).filter((v) => v > 0);
  const closeTimes = positions
    .map((p) => p.closeTime ?? 0)
    .filter((t) => t > 0);
  return {
    side: long ? 'LONG' : 'SHORT',
    entryPrice: entry,
    exitPrice: exit,
    lots: Number(volume.toFixed(2)),
    stopPrice: stops.length
      ? long
        ? Math.max(...stops)
        : Math.min(...stops)
      : null,
    targetPrice: targets.length
      ? long
        ? Math.max(...targets)
        : Math.min(...targets)
      : null,
    openedAt: new Date(Math.min(...positions.map((p) => p.openTime)) * 1000),
    exitedAt:
      allClosed && closeTimes.length
        ? new Date(Math.max(...closeTimes) * 1000)
        : null,
    externalRef: positions
      .map((p) => p.id)
      .sort()
      .join(','),
  };
}
