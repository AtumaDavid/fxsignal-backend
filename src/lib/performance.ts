import type { PairCode, Prediction } from './model.js';

interface Bucket {
  key: string;
  signals: number;
  scored: number;
  hits: number;
  misses: number;
  hitRate: number | null;
  netPips: number;
  avgConfidence: number | null;
}

export interface PerformanceSummary {
  totals: Bucket & { notTriggered: number; pending: number; neutral: number };
  byPair: Bucket[];
  bySession: Bucket[];
  /** Cumulative net pips over scored signals, oldest first. */
  curve: { at: string; pips: number; pairCode: PairCode }[];
}

function emptyBucket(key: string): Bucket {
  return {
    key,
    signals: 0,
    scored: 0,
    hits: 0,
    misses: 0,
    hitRate: null,
    netPips: 0,
    avgConfidence: null,
  };
}

function finalize(bucket: Bucket, confidenceSum: number): Bucket {
  return {
    ...bucket,
    hitRate:
      bucket.scored > 0
        ? Number(((bucket.hits / bucket.scored) * 100).toFixed(1))
        : null,
    netPips: Number(bucket.netPips.toFixed(1)),
    avgConfidence:
      bucket.signals > 0 ? Math.round(confidenceSum / bucket.signals) : null,
  };
}

/**
 * Track record from settled signals. Only HIT and MISSED count as scored —
 * neutral calls, untriggered entries and pending rows are reported separately
 * so they never inflate (or deflate) the hit rate.
 */
export function buildPerformance(rows: Prediction[]): PerformanceSummary {
  const groups = new Map<string, { bucket: Bucket; confidence: number }>();
  const group = (key: string) => {
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        bucket: emptyBucket(key.split(':').slice(1).join(':')),
        confidence: 0,
      };
      groups.set(key, entry);
    }
    return entry;
  };

  let notTriggered = 0;
  let pending = 0;
  let neutral = 0;
  const scoredRows: Prediction[] = [];

  for (const row of rows) {
    const status = row.outcome?.status ?? 'PENDING';
    const keys = [
      'total:all',
      `pair:${row.pairCode}`,
      `session:${row.session}`,
    ];
    const isScored = status === 'HIT' || status === 'MISSED';
    for (const key of keys) {
      const entry = group(key);
      entry.bucket.signals += 1;
      entry.confidence += row.confidence;
      if (isScored) {
        entry.bucket.scored += 1;
        if (status === 'HIT') entry.bucket.hits += 1;
        else entry.bucket.misses += 1;
        entry.bucket.netPips += row.outcome?.movementPips ?? 0;
      }
    }
    if (isScored) scoredRows.push(row);
    else if (status === 'PENDING') pending += 1;
    else if (row.direction === 'NEUTRAL') neutral += 1;
    else notTriggered += 1;
  }

  const pick = (prefix: string) =>
    [...groups.entries()]
      .filter(([key]) => key.startsWith(`${prefix}:`))
      .map(([, entry]) => finalize(entry.bucket, entry.confidence))
      .sort((a, b) => b.signals - a.signals);

  const total = groups.get('total:all');
  let running = 0;
  const curve = scoredRows
    .sort(
      (a, b) =>
        new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime()
    )
    .map((row) => {
      running += row.outcome?.movementPips ?? 0;
      return {
        // Plot at the window close, not when settlement happened to run.
        at: row.expiresAt,
        pips: Number(running.toFixed(1)),
        pairCode: row.pairCode,
      };
    });

  return {
    totals: {
      ...(total
        ? finalize(total.bucket, total.confidence)
        : emptyBucket('all')),
      key: 'all',
      notTriggered,
      pending,
      neutral,
    },
    byPair: pick('pair'),
    bySession: pick('session'),
    curve,
  };
}
