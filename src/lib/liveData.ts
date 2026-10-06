import { cached, withCredits } from './rateCache.js';
import type { Impact, PairCode } from './model.js';
import type { Candle, Timeframe } from './technical.js';

export type { Candle };

export interface LiveMarketEvent {
  externalId: string;
  currency: string;
  title: string;
  eventDate: Date;
  impact: Impact;
  forecast: string | null;
  previousValue: string | null;
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

async function getJson<T>(
  url: string,
  provider: string,
  headers?: Record<string, string>
): Promise<T> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(8_000),
  });
  const text = await response.text();
  let body: (T & { status?: string; message?: string; error?: string }) | null =
    null;
  try {
    body = JSON.parse(text) as T & {
      status?: string;
      message?: string;
      error?: string;
    };
  } catch {
    throw new Error(
      `${provider} returned a non-JSON response (${response.status}): ${text.slice(0, 180)}`
    );
  }
  if (!response.ok || body.status === 'error' || body.error) {
    throw new Error(
      `${provider} request failed (${response.status}): ${body.message ?? body.error ?? text.slice(0, 180)}`
    );
  }
  return body as T;
}

interface TwelveSeriesResponse {
  values?: Array<{
    datetime: string;
    open: string;
    high: string;
    low: string;
    close: string;
  }>;
  status?: string;
  message?: string;
}

// ---- Free-tier friendly caching -------------------------------------------------
// Twelve Data bills one credit per request and the plan allows 8 credits/minute.
// Every call below goes through the shared cache in `rateCache.ts`, which is
// restart-safe, de-duplicates concurrent callers, and backs off after failures,
// plus a rolling-minute credit budget that queues instead of bursting.
const EVENTS_TTL_MS = 15 * 60_000; // economic calendar rarely changes intra-day

function twelveDataUrl(path: string, params: Record<string, string>) {
  const query = new URLSearchParams({
    ...params,
    // Pin timestamps to UTC: settlement compares candle times to signal windows.
    timezone: 'UTC',
    apikey: requiredEnv('TWELVE_DATA_API_KEY'),
  });
  return `https://api.twelvedata.com/${path}?${query.toString()}`;
}

/** Candle start time; Twelve Data returns "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DD" in UTC. */
export function candleTime(candle: Candle): number {
  const iso = candle.datetime.includes(' ')
    ? `${candle.datetime.replace(' ', 'T')}Z`
    : `${candle.datetime}T00:00:00Z`;
  return Date.parse(iso);
}

// ---- Multi-timeframe candles (monthly → intraday) ---------------------------
// Twelve Data bills 1 credit per series request. Higher timeframes barely move
// intraday, so they are cached long; only H1/M15 refresh inside the 6h window.
// Steady-state cost stays ~2–4 credits per pair per window.

const TF_CONFIG: Record<
  Timeframe,
  { interval: string; outputsize: string; ttlMs: number }
> = {
  MONTHLY: { interval: '1month', outputsize: '60', ttlMs: 24 * 60 * 60 * 1000 },
  WEEKLY: { interval: '1week', outputsize: '104', ttlMs: 12 * 60 * 60 * 1000 },
  DAILY: { interval: '1day', outputsize: '180', ttlMs: 6 * 60 * 60 * 1000 },
  H4: { interval: '4h', outputsize: '180', ttlMs: 3 * 60 * 60 * 1000 },
  H1: { interval: '1h', outputsize: '200', ttlMs: 45 * 60 * 1000 },
  M15: { interval: '15min', outputsize: '192', ttlMs: 20 * 60 * 1000 },
};

export type MultiTimeframe = Record<Timeframe, Candle[]>;

function parseCandles(values: TwelveSeriesResponse['values']): Candle[] {
  return (values ?? [])
    .map((candle) => ({
      datetime: candle.datetime,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
    }))
    .filter((candle) =>
      [candle.open, candle.high, candle.low, candle.close].every((value) =>
        Number.isFinite(value)
      )
    );
}

/** Newest-first candles for one pair + timeframe (as returned by the API). */
export async function fetchTimeframeCandles(
  pairCode: PairCode,
  timeframe: Timeframe,
  /** Refetch (cache permitting) if the series has no candle starting at or after this time. */
  needCandleFrom?: number
): Promise<Candle[]> {
  const config = TF_CONFIG[timeframe];
  return cached(
    `twelvedata:tf:${pairCode}:${timeframe}`,
    async () => {
      const seriesData = await withCredits(1, () =>
        getJson<TwelveSeriesResponse>(
          twelveDataUrl('time_series', {
            symbol: pairCode,
            interval: config.interval,
            outputsize: config.outputsize,
          }),
          'Twelve Data'
        )
      );
      const candles = parseCandles(seriesData.values);
      if (candles.length < 5)
        throw new Error(`No ${timeframe} series returned for ${pairCode}.`);
      return candles;
    },
    {
      ttlMs: config.ttlMs,
      serveStaleOnError: true,
      staleIf:
        needCandleFrom === undefined
          ? undefined
          : (candles) => !candles.some((c) => candleTime(c) >= needCandleFrom),
    }
  );
}

/**
 * All six timeframes for one pair. Partially tolerant: if a single timeframe
 * fails, the rest still return (the engine requires DAILY + H1 minimum and
 * treats the rest as optional context).
 */
export async function fetchMultiTimeframe(
  pairCode: PairCode,
  timeframes: Timeframe[] = Object.keys(TF_CONFIG) as Timeframe[]
): Promise<MultiTimeframe> {
  const entries = await Promise.all(
    timeframes.map(async (timeframe) => {
      try {
        return [
          timeframe,
          await fetchTimeframeCandles(pairCode, timeframe),
        ] as const;
      } catch (error) {
        console.warn(
          `MTF ${timeframe} unavailable for ${pairCode}.`,
          error instanceof Error ? error.message : error
        );
        return [timeframe, []] as const;
      }
    })
  );
  // Timeframes not requested come back empty.
  const empty = Object.fromEntries(
    (Object.keys(TF_CONFIG) as Timeframe[]).map((tf) => [tf, [] as Candle[]])
  );
  return { ...empty, ...Object.fromEntries(entries) } as MultiTimeframe;
}

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function normalizeImpact(value: unknown): Impact {
  const numeric = Number(value);
  if (numeric >= 3 || String(value).toLowerCase() === 'high') return 'HIGH';
  if (numeric === 2 || String(value).toLowerCase() === 'medium')
    return 'MEDIUM';
  return 'LOW';
}

interface TradingEconomicsEvent {
  CalendarID?: string | number;
  Date?: string;
  Currency?: string;
  Country?: string;
  Event?: string;
  Importance?: string | number;
  Forecast?: string | number | null;
  Previous?: string | number | null;
}

export async function fetchLiveEvents(
  now = new Date()
): Promise<LiveMarketEvent[]> {
  return fetchEventsRange(now, 2, 'tradingeconomics:calendar');
}

/** Week-ahead calendar for the weekend outlook (Monday → Sunday). */
export async function fetchWeekEvents(
  weekStart: Date
): Promise<LiveMarketEvent[]> {
  const key = `tradingeconomics:week:${weekStart.toISOString().slice(0, 10)}`;
  return fetchEventsRange(weekStart, 7, key);
}

async function fetchEventsRange(
  start: Date,
  daysAhead: number,
  cacheKey: string
): Promise<LiveMarketEvent[]> {
  return cached(cacheKey, () => fetchLiveEventsLive(start, daysAhead), {
    ttlMs: EVENTS_TTL_MS,
    serveStaleOnError: true,
    // JSON has no Date instances, so rehydrate entries read back from disk.
    revive: (raw) =>
      (raw as LiveMarketEvent[]).map((event) => ({
        ...event,
        eventDate: new Date(event.eventDate),
      })),
  });
}

async function fetchLiveEventsLive(
  now = new Date(),
  daysAhead = 2
): Promise<LiveMarketEvent[]> {
  const apiKey = requiredEnv('TRADING_ECONOMICS_API_KEY');
  const end = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    c: apiKey,
    d1: dateOnly(now),
    d2: dateOnly(end),
    f: 'json',
  });
  const url = `https://api.tradingeconomics.com/calendar/country/united states,euro area,japan?${params.toString()}`;
  const rows = await getJson<TradingEconomicsEvent[]>(
    url,
    'Trading Economics',
    { Authorization: apiKey }
  );
  return rows
    .filter((row) =>
      ['USD', 'EUR', 'JPY'].includes(String(row.Currency ?? '').toUpperCase())
    )
    .filter((row) => row.Date && row.Event)
    .map((row) => ({
      externalId: String(
        row.CalendarID ?? `${row.Date}-${row.Country}-${row.Event}`
      ),
      currency: String(row.Currency).toUpperCase(),
      title: String(row.Event),
      eventDate: new Date(String(row.Date)),
      impact: normalizeImpact(row.Importance),
      forecast:
        row.Forecast === null || row.Forecast === undefined
          ? null
          : String(row.Forecast),
      previousValue:
        row.Previous === null || row.Previous === undefined
          ? null
          : String(row.Previous),
    }));
}

export function liveDataEnabled() {
  return (
    process.env.LIVE_DATA_ENABLED === 'true' &&
    Boolean(process.env.TWELVE_DATA_API_KEY)
  );
}

export function aiAnalysisEnabled() {
  return (
    liveDataEnabled() &&
    process.env.AI_ANALYSIS_ENABLED === 'true' &&
    Boolean(process.env.DEEPSEEK_API_KEY)
  );
}
