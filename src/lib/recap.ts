import { weekBounds } from './market.js';
import type { PairCode, Prediction } from './model.js';

/** One trade's result in R (pips over the stop distance); null if unscored. */
export function resultR(p: Prediction): number | null {
  const pips = p.outcome?.movementPips;
  if (pips === null || pips === undefined || !p.stopPips) return null;
  return Number((pips / p.stopPips).toFixed(2));
}

/** Engine results that count as a trade outcome (filled and closed). */
const CLOSED = new Set(['HIT', 'MISSED', 'CLOSED_EARLY', 'BREAKEVEN']);

export interface RecapGroup {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  netPips: number;
  netR: number;
}

export interface UserWeek {
  logged: number;
  closed: number;
  wins: number;
  losses: number;
  netPips: number;
}

export interface WeeklyRecap {
  weekStart: string;
  weekEnd: string;
  /** Mondays of recent weeks (newest first), for the week picker. */
  weeks: string[];
  engine: {
    signals: number;
    closed: number;
    open: number;
    notTriggered: number;
    cancelled: number;
    wins: number;
    losses: number;
    winRate: number | null;
    netPips: number;
    netR: number;
    best: { id: string; pairCode: PairCode; pips: number } | null;
    worst: { id: string; pairCode: PairCode; pips: number } | null;
  };
  days: { date: string; trades: number; netPips: number }[];
  byPair: RecapGroup[];
  bySession: RecapGroup[];
  you: UserWeek;
  trades: Prediction[];
}

const round = (n: number, d = 1) => Number(n.toFixed(d));

function group(rows: Prediction[], keyOf: (p: Prediction) => string) {
  const map = new Map<string, RecapGroup>();
  for (const p of rows) {
    const key = keyOf(p);
    const g = map.get(key) ?? {
      key,
      trades: 0,
      wins: 0,
      losses: 0,
      netPips: 0,
      netR: 0,
    };
    const pips = p.outcome?.movementPips ?? 0;
    g.trades += 1;
    if (p.outcome?.status === 'HIT') g.wins += 1;
    if (p.outcome?.status === 'MISSED') g.losses += 1;
    g.netPips += pips;
    g.netR += resultR(p) ?? 0;
    map.set(key, g);
  }
  return [...map.values()]
    .map((g) => ({ ...g, netPips: round(g.netPips), netR: round(g.netR, 2) }))
    .sort((a, b) => b.netPips - a.netPips);
}

/** Mondays of the `count` trading weeks up to the one containing `now`. */
export function recentWeeks(now: Date, count = 8): string[] {
  const { weekStart } = weekBounds(now);
  return Array.from({ length: count }, (_, i) =>
    new Date(weekStart.getTime() - i * 7 * 86_400_000)
      .toISOString()
      .slice(0, 10)
  );
}

/**
 * A trading week in one page: what the engine published and how it ended,
 * day by day, by pair and session, plus the user's own journal for the week.
 * `signals` are the week's published calls (no holds); `userTrades` the
 * user's journal rows on those signals.
 */
export function buildRecap(
  weekStart: Date,
  signals: Prediction[],
  userTrades: { pips: number | null }[],
  weeks: string[]
): WeeklyRecap {
  const { weekEnd } = weekBounds(weekStart);
  const trades = signals.filter((p) => p.direction !== 'NEUTRAL');
  const closed = trades.filter((p) => CLOSED.has(p.outcome?.status ?? ''));
  const wins = closed.filter((p) => p.outcome?.status === 'HIT').length;
  const losses = closed.filter((p) => p.outcome?.status === 'MISSED').length;
  const pipsOf = (p: Prediction) => p.outcome?.movementPips ?? 0;
  const ranked = [...closed].sort((a, b) => pipsOf(b) - pipsOf(a));
  const pick = (p: Prediction | undefined) =>
    p ? { id: p.id, pairCode: p.pairCode, pips: pipsOf(p) } : null;

  const days = Array.from({ length: 5 }, (_, i) => {
    const date = new Date(weekStart.getTime() + i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const onDay = closed.filter((p) => p.validFrom.slice(0, 10) === date);
    return {
      date,
      trades: onDay.length,
      netPips: round(onDay.reduce((sum, p) => sum + pipsOf(p), 0)),
    };
  });

  const closedUser = userTrades.filter((t) => t.pips !== null);
  return {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    weeks,
    engine: {
      signals: trades.length,
      closed: closed.length,
      open: trades.filter((p) => p.outcome?.status === 'PENDING').length,
      notTriggered: trades.filter(
        (p) =>
          p.outcome?.status === 'EXPIRED' && p.outcome.movementPips === null
      ).length,
      cancelled: trades.filter((p) => p.outcome?.status === 'CANCELLED').length,
      wins,
      losses,
      winRate: wins + losses > 0 ? round((wins / (wins + losses)) * 100) : null,
      netPips: round(closed.reduce((sum, p) => sum + pipsOf(p), 0)),
      netR: round(
        closed.reduce((sum, p) => sum + (resultR(p) ?? 0), 0),
        2
      ),
      best: ranked.length && pipsOf(ranked[0]) > 0 ? pick(ranked[0]) : null,
      worst:
        ranked.length && pipsOf(ranked[ranked.length - 1]) < 0
          ? pick(ranked[ranked.length - 1])
          : null,
    },
    days,
    byPair: group(closed, (p) => p.pairCode),
    bySession: group(closed, (p) => p.session),
    you: {
      logged: userTrades.length,
      closed: closedUser.length,
      wins: closedUser.filter((t) => (t.pips ?? 0) > 0).length,
      losses: closedUser.filter((t) => (t.pips ?? 0) < 0).length,
      netPips: round(closedUser.reduce((sum, t) => sum + (t.pips ?? 0), 0)),
    },
    trades: [...trades].sort(
      (a, b) =>
        new Date(a.validFrom).getTime() - new Date(b.validFrom).getTime()
    ),
  };
}
