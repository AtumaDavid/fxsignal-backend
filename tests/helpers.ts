import type { Candle } from '../src/lib/technical.js';
import type { Prediction } from '../src/lib/model.js';

/** Builds consecutive 15-minute candles from [low, high, close?] tuples. */
export function m15(
  startIso: string,
  bars: [number, number, number?][]
): Candle[] {
  let t = Date.parse(startIso);
  return bars.map(([low, high, close]) => {
    const datetime = new Date(t).toISOString().slice(0, 19).replace('T', ' ');
    t += 15 * 60_000;
    const c = close ?? (low + high) / 2;
    return { datetime, open: c, high, low, close: c };
  });
}

/** A long EUR/USD trade: zone 1.1000–1.1010 (mid 1.1005), stop 1.0985 (20p = 1R),
 *  TP1 1.1025 (+1R), TP2 1.1045 (+2R), TP3 1.1065 (+3R). */
export const LONG_LEVELS = {
  pairCode: 'EUR/USD',
  direction: 'LONG',
  entryLow: 1.1,
  entryHigh: 1.101,
  targetPrice: 1.1045,
  invalidationPrice: 1.0985,
  target3Price: 1.1065,
} as const;

export function prediction(overrides: Partial<Prediction> = {}): Prediction {
  return {
    id: '1',
    pairCode: 'EUR/USD',
    windowKey: '2026-10-06-LONDON',
    direction: 'LONG',
    engine: 'RULE_BASED',
    modelName: null,
    confidence: 70,
    entryLow: 1.1,
    entryHigh: 1.101,
    targetPrice: 1.1045,
    target1Price: 1.1025,
    target3Price: 1.1065,
    invalidationPrice: 1.0985,
    rationale: '',
    factors: [],
    session: 'London',
    playbook: null,
    timeframeBias: null,
    stopPips: 20,
    targetPips: 40,
    riskReward: 2,
    atrPips: 18,
    continuesId: null,
    validFrom: '2026-10-06T07:00:00.000Z',
    expiresAt: '2026-10-06T12:00:00.000Z',
    createdAt: '2026-10-06T07:00:00.000Z',
    outcome: {
      status: 'PENDING',
      resolvedPrice: null,
      movementPips: null,
      evaluatedAt: null,
      source: 'LIVE',
      note: null,
    },
    ...overrides,
  };
}
