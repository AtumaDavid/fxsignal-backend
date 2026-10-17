// ---- Signal-quality analytics ---------------------------------------------------
//
// Results grouped by a dimension (pair, session, regime, …) with sample size
// and a bootstrap range for the average R. A group with few trades, or a
// range that spans zero, is not evidence: the UI says so. Nothing here
// changes the engine; a dimension earns a rule only if it holds out of sample.

export interface ScoredTrade {
  pairCode: string;
  session: string;
  direction: string;
  /** Result in R after costs where known. */
  r: number;
  status: string;
  closedAt: string | null;
  entryTrigger: string | null;
  strategy: string | null;
  features: {
    trend?: string;
    volatility?: string;
    choppy?: boolean;
    newsInWindow?: boolean;
    contextAligned?: boolean;
  } | null;
  confidence: number;
}

export type Dimension =
  | 'pair'
  | 'session'
  | 'direction'
  | 'strategy'
  | 'trigger'
  | 'trend'
  | 'volatility'
  | 'choppy'
  | 'news'
  | 'context'
  | 'confidence';

export const DIMENSIONS: { key: Dimension; label: string }[] = [
  { key: 'pair', label: 'Pair' },
  { key: 'session', label: 'Session' },
  { key: 'direction', label: 'Direction' },
  { key: 'strategy', label: 'Rule version' },
  { key: 'trigger', label: 'Entry trigger' },
  { key: 'trend', label: 'Trend / range' },
  { key: 'volatility', label: 'Volatility' },
  { key: 'choppy', label: 'Choppy H1' },
  { key: 'news', label: 'High-impact news in window' },
  { key: 'context', label: 'Daily and H4 aligned' },
  { key: 'confidence', label: 'Confidence' },
];

/** Below this many trades a group is shown but marked as too small to judge. */
export const MIN_SAMPLE = 30;

function keyOf(t: ScoredTrade, d: Dimension): string {
  const f = t.features;
  const yesNo = (v: boolean | undefined) => (v === undefined ? 'unknown' : v ? 'yes' : 'no');
  switch (d) {
    case 'pair':
      return t.pairCode;
    case 'session':
      return t.session;
    case 'direction':
      return t.direction;
    case 'strategy':
      return t.strategy ?? 'unversioned';
    case 'trigger':
      return t.entryTrigger ?? 'TOUCH';
    case 'trend':
      return f?.trend ?? 'unknown';
    case 'volatility':
      return f?.volatility ?? 'unknown';
    case 'choppy':
      return yesNo(f?.choppy);
    case 'news':
      return yesNo(f?.newsInWindow);
    case 'context':
      return yesNo(f?.contextAligned);
    case 'confidence':
      return t.confidence >= 75 ? '75+' : t.confidence >= 60 ? '60–74' : 'under 60';
  }
}

export interface GroupStats {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netR: number;
  /** Expectancy: average R per trade. */
  avgR: number;
  /** 90% bootstrap range for avgR. */
  avgRLow: number;
  avgRHigh: number;
  maxDrawdownR: number;
  /** Too few trades, or the range includes zero. */
  inconclusive: boolean;
}

function bootstrapRange(rs: number[], runs = 1000, seed = 11): [number, number] {
  if (rs.length < 2) return [rs[0] ?? 0, rs[0] ?? 0];
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const means: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    let sum = 0;
    for (let i = 0; i < rs.length; i += 1) sum += rs[Math.floor(rnd() * rs.length)];
    means.push(sum / rs.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(runs * 0.05)], means[Math.floor(runs * 0.95)]];
}

export function groupStats(trades: ScoredTrade[], d: Dimension): GroupStats[] {
  const groups = new Map<string, ScoredTrade[]>();
  for (const t of trades) {
    const k = keyOf(t, d);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const r2 = (x: number) => Number(x.toFixed(2));
  return [...groups.entries()]
    .map(([key, list]) => {
      const ordered = [...list].sort((a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? ''));
      const rs = ordered.map((t) => t.r);
      const net = rs.reduce((a, b) => a + b, 0);
      const wins = list.filter((t) => t.status === 'HIT').length;
      const losses = list.filter((t) => t.status === 'MISSED').length;
      let equity = 0;
      let peak = 0;
      let dd = 0;
      for (const r of rs) {
        equity += r;
        peak = Math.max(peak, equity);
        dd = Math.max(dd, peak - equity);
      }
      const [low, high] = bootstrapRange(rs);
      return {
        key,
        trades: list.length,
        wins,
        losses,
        winRate: wins + losses > 0 ? Number(((wins / (wins + losses)) * 100).toFixed(1)) : null,
        netR: r2(net),
        avgR: r2(net / list.length),
        avgRLow: r2(low),
        avgRHigh: r2(high),
        maxDrawdownR: r2(dd),
        inconclusive: list.length < MIN_SAMPLE || (low <= 0 && high >= 0),
      };
    })
    .sort((a, b) => b.trades - a.trades);
}
