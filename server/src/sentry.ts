import { env } from './env';

let sentry: typeof import('@sentry/bun') | null = null;

export async function initSentry(): Promise<void> {
  if (!env.SENTRY_DSN) return;

  sentry = await import('@sentry/bun');
  sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.2 : undefined,
  });
}

export function captureException(error: unknown): void {
  if (!sentry) return;
  sentry.captureException(error);
}

export function isEnabled(): boolean {
  return sentry !== null;
}
