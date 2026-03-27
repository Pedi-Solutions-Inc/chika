import * as Sentry from '@sentry/bun';
import { env } from './env';

let initialized = false;

export function initSentry(): void {
  if (!env.SENTRY_DSN) return;

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.2 : 1.0,
  });

  initialized = true;
}

export function captureException(error: unknown): void {
  if (!initialized) return;
  Sentry.captureException(error);
}

export function isEnabled(): boolean {
  return initialized;
}
