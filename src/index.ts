import 'dotenv/config';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import cors from 'cors';
import { bootstrapDatabase } from './lib/bootstrap.js';
import { checkDatabase, prisma } from './lib/prisma.js';
import { maintainMarketData, onCandleClose } from './lib/predictions.js';
import { requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import authRoutes from './routes/auth.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import eventsRoutes from './routes/events.routes.js';
import historyRoutes from './routes/history.routes.js';
import predictionsRoutes from './routes/predictions.routes.js';
import outlookRoutes from './routes/outlook.routes.js';
import billingRoutes from './routes/billing.routes.js';
import candlesRoutes from './routes/candles.routes.js';
import publicRoutes from './routes/public.routes.js';
import journalRoutes from './routes/journal.routes.js';
import notificationsRoutes from './routes/notifications.routes.js';
import recapRoutes from './routes/recap.routes.js';

const app = express();
const port = Number(process.env.PORT) || 4004;

app.disable('x-powered-by');
app.set('trust proxy', 1);
// Local dev friendliness: the frontend may run on any localhost port (Vite
// auto-increments when 5173 is taken). Always allow loopback origins plus the
// explicitly configured FRONTEND_URL list; anything else is rejected.
// The deployed web app is always allowed; FRONTEND_URL can add more
// (comma-separated). Browsers send Origin without a trailing slash, so strip
// one if it was pasted in.
const PRODUCTION_ORIGINS = ['https://fxsignal-frontend.vercel.app'];
const configuredOrigins = new Set(
  [...PRODUCTION_ORIGINS, ...(process.env.FRONTEND_URL ?? '').split(',')]
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean)
);
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // curl / same-origin / non-browser
  if (configuredOrigins.has(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}
class CorsRejected extends Error {}
app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) callback(null, true);
      else callback(new CorsRejected(`Origin ${origin} is not allowed.`));
    },
  })
);
app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.get('/health', async (_req, res) => {
  res.json({
    ok: true,
    service: 'fxsignal-api',
    version: '2.0.0',
    database: (await checkDatabase()) ? 'connected' : 'offline',
  });
});

// Abuse-prone endpoints get a sliding window: 20 auth attempts/min per IP.
app.use('/api/auth', rateLimit(20, 60_000), authRoutes);
// `?refresh=1` runs a forced provider pass (and possibly a minute-long AI
// call), so it gets its own tight budget on top of the server-wide cooldown.
const refreshLimit = rateLimit(4, 10 * 60_000);
app.use((req, res, next) =>
  req.query.refresh === '1' ? refreshLimit(req, res, next) : next()
);
app.use('/api/dashboard', requireAuth, dashboardRoutes);
app.use('/api/predictions', requireAuth, predictionsRoutes);
app.use('/api/events', requireAuth, eventsRoutes);
app.use('/api/history', requireAuth, historyRoutes);
app.use('/api/outlook', requireAuth, outlookRoutes);
app.use('/api/candles', requireAuth, candlesRoutes);
app.use('/api/journal', requireAuth, journalRoutes);
app.use('/api/notifications', requireAuth, notificationsRoutes);
app.use('/api/recap', requireAuth, recapRoutes);
// Unauthenticated, so it gets its own per-IP budget.
app.use('/api/public', rateLimit(60, 60_000), publicRoutes);
app.use('/api/billing', billingRoutes);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.use(
  (
    error: Error & { type?: string },
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    if (error instanceof CorsRejected) {
      return res.status(403).json({ error: error.message });
    }
    if (error.type === 'entity.parse.failed') {
      return res
        .status(400)
        .json({ error: 'The request body is not valid JSON.' });
    }
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'The request body is too large.' });
    }
    console.error(error);
    res
      .status(500)
      .json({ error: 'Something went wrong on our side. Please try again.' });
  }
);

const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes

async function start() {
  try {
    await bootstrapDatabase();
    console.log('Postgres connected and schema verified.');
  } catch (error) {
    console.warn(
      'Postgres is unavailable; market data will be empty until it connects.',
      error instanceof Error ? error.message : error
    );
  }

  // Background maintenance: generates/settles the current window's signals and
  // syncs the calendar, so the database always has fresh data ready before any
  // client request. Web refreshes then read the database with zero provider
  // calls (free-tier rate limits are respected via caching + cooldowns).
  const runMaintenance = () => {
    maintainMarketData().catch((error) => {
      console.warn(
        'Scheduled market-data maintenance failed.',
        error instanceof Error ? error.message : error
      );
    });
  };
  runMaintenance();
  const maintenanceTimer = setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);
  // Candle-close loop: cheap when idle (it acts once per M15 / H1 close and
  // only when something is open), so it can check every minute.
  const candleTimer = setInterval(() => {
    onCandleClose().catch((error) =>
      console.warn(
        'Candle-close loop failed.',
        error instanceof Error ? error.message : error
      )
    );
  }, 60_000);

  const server = app.listen(port, () => {
    console.log(`FXSignal API listening on http://localhost:${port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down.`);
    clearInterval(maintenanceTimer);
    clearInterval(candleTimer);
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
    // Do not hang forever on a long-lived connection.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

void start();
