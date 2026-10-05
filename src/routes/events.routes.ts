import { Router } from 'express';
import { prisma } from '../lib/prisma.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    // Read-only: the calendar sync is owned by background maintenance, so web
    // refreshes never spend provider calls here.
    const result = await prisma.marketEvent.findMany({
      where: { eventDate: { gte: new Date() } },
      orderBy: { eventDate: 'asc' },
      take: 80,
    });
    return res.json(
      result.map((row) => ({
        id: String(row.id),
        currency: row.currency,
        title: row.title,
        eventDate: row.eventDate.toISOString(),
        impact: row.impact,
        forecast: row.forecast,
        previousValue: row.previousValue,
      }))
    );
  } catch (error) {
    console.warn(
      'Events unavailable:',
      error instanceof Error ? error.message : error
    );
    return res.json([]);
  }
});

export default router;
