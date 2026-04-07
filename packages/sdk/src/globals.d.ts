/**
 * DOMException is available at runtime in React Native (Hermes/JSC polyfills)
 * but TypeScript won't know about it unless "dom" is in lib — which RN projects
 * intentionally omit. This declaration makes the SDK compile and type-check in
 * any consumer without pulling in the full DOM lib.
 */
declare class DOMException extends Error {
  constructor(message?: string, name?: string);
  readonly name: string;
  readonly message: string;
}
