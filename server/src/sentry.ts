import { env } from './env';

let sentry: typeof import('@sentry/bun') | null = null;

export async function initSentry(): Promise<void> {
  if (!env.SENTRY_DSN) return;

  sentry = await import('@sentry/bun');
  sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    defaultIntegrations: false,
    skipOpenTelemetrySetup: true,
    integrations: [
      sentry.onUncaughtExceptionIntegration(),
      sentry.onUnhandledRejectionIntegration(),
      sentry.linkedErrorsIntegration(),
      sentry.contextLinesIntegration(),
      sentry.nodeContextIntegration(),
    ],
  });
}

export function captureException(error: unknown): void {
  if (!sentry) return;
  sentry.captureException(error);
}

export function isEnabled(): boolean {
  return sentry !== null;
}
