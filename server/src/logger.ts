import { env } from './env';

// ---------------------------------------------------------------------------
// Log levels
// ---------------------------------------------------------------------------

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const LOG_LEVEL: Level =
  (Bun.env.LOG_LEVEL as Level | undefined) ??
  (env.NODE_ENV === 'production' ? 'info' : 'debug');

// ---------------------------------------------------------------------------
// Color helpers (dev mode only)
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const COLORS: Record<Level, string> = {
  debug: '\x1b[36m',  // cyan
  info: '\x1b[32m',   // green
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
};

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  child(defaultCtx: LogContext): Logger;
}

const isProd = env.NODE_ENV === 'production';

function formatDev(level: Level, msg: string, ctx: LogContext | undefined): string {
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  const color = COLORS[level];
  const lvl = level.toUpperCase().padEnd(5);

  let line = `${DIM}${ts}${RESET} ${color}${lvl}${RESET} ${msg}`;

  if (ctx && Object.keys(ctx).length > 0) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(ctx)) {
      if (v instanceof Error) {
        parts.push(`${k}=${v.message}`);
      } else if (typeof v === 'string') {
        parts.push(`${k}=${v}`);
      } else {
        parts.push(`${k}=${JSON.stringify(v)}`);
      }
    }
    line += ` ${DIM}${parts.join(' ')}${RESET}`;
  }

  return line;
}

function formatJson(level: Level, msg: string, ctx: LogContext | undefined): string {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (ctx) {
    for (const [k, v] of Object.entries(ctx)) {
      if (v instanceof Error) {
        entry[k] = { message: v.message, stack: v.stack };
      } else {
        entry[k] = v;
      }
    }
  }
  return JSON.stringify(entry);
}

function write(level: Level, msg: string, ctx: LogContext | undefined): void {
  if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;

  const line = isProd ? formatJson(level, msg, ctx) : formatDev(level, msg, ctx);

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function createLogger(defaultCtx?: LogContext): Logger {
  function merge(ctx?: LogContext): LogContext | undefined {
    if (!defaultCtx && !ctx) return undefined;
    if (!defaultCtx) return ctx;
    if (!ctx) return defaultCtx;
    return { ...defaultCtx, ...ctx };
  }

  return {
    debug: (msg, ctx) => write('debug', msg, merge(ctx)),
    info: (msg, ctx) => write('info', msg, merge(ctx)),
    warn: (msg, ctx) => write('warn', msg, merge(ctx)),
    error: (msg, ctx) => write('error', msg, merge(ctx)),
    child: (childCtx) => createLogger({ ...defaultCtx, ...childCtx }),
  };
}

/** Root logger — use for startup/shutdown and module-level logging. */
export const log = createLogger();

/**
 * Create a child logger with a component name.
 * Usage: `const log = createComponentLogger('plugins');`
 */
export function createComponentLogger(component: string): Logger {
  return log.child({ component });
}