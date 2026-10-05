import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 does not forward rejected promises to the error handler, so an
 * async route that throws (for example while Postgres is down) would leave the
 * request hanging and surface as an unhandled rejection that terminates Node.
 * Wrap every async handler that does not catch its own errors.
 */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
