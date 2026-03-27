/**
 * Configurable auth validator types.
 *
 * Implementors create an `auth.config.ts` file (gitignored) that exports
 * an {@link AuthConfig} object.  The server dynamically imports it at
 * startup; if the file is absent, auth is disabled.
 */

/** The context passed to every validator invocation. */
export interface AuthValidatorContext {
  /** All request headers (lowercased keys). */
  headers: Record<string, string>;
  /** The channel being accessed. */
  channelId: string;
}

/** What the validator must return. */
export interface AuthValidatorResult {
  /** Whether the request is allowed. */
  valid: boolean;
  /** Optional user identifier — stored for audit / logging. */
  userId?: string;
}

/**
 * A function that decides whether an incoming request is authorised.
 *
 * Return `{ valid: true }` to allow, `{ valid: false }` to reject (401).
 */
export type AuthValidator = (
  ctx: AuthValidatorContext,
) => Promise<AuthValidatorResult> | AuthValidatorResult;

/** The shape of the default export in `auth.config.ts`. */
export interface AuthConfig {
  /** The validation function. */
  validate: AuthValidator;
  /**
   * How long (ms) a **valid** result is cached per cache-key.
   * Set to `0` to disable caching.  Defaults to `300_000` (5 min).
   */
  cacheTtl?: number;
  /**
   * How long (ms) an **invalid** result is cached per cache-key.
   * Defaults to `2_000` (2 s).
   */
  invalidCacheTtl?: number;
  /**
   * Derive a cache key from the request context.
   * Defaults to the full `Authorization` header value.
   * Return `null` to skip caching for a request.
   */
  cacheKey?: (ctx: AuthValidatorContext) => string | null;
}