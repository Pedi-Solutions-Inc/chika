# @pedi/chika-types — Agent Guide

> **Maintenance rule:** When you add, rename, or remove types/schemas, update this file and `src/index.ts` re-exports accordingly.

Zero-dependency shared types package (only depends on Zod). Defines all TypeScript interfaces and Zod validation schemas used across the chat system.

## ChatDomain Generic System

All domain-specific types are parameterized by a single `ChatDomain` interface:

```typescript
interface ChatDomain {
  role: string;                    // participant role union
  metadata: Record<string, unknown>; // participant metadata shape
  messageType: string;             // message type union
  attributes: Record<string, unknown>; // message attributes shape
}
```

Consumers define their domain once and it flows through everything:

```typescript
interface RideHailingChat extends ChatDomain {
  role: 'driver' | 'rider';
  metadata: { vehicle?: { type: string; plate_number: string } };
  messageType: 'chat' | 'driver_arrived' | 'booking_completed';
  attributes: { location?: { lat: number; lng: number } };
}

// Then: Participant<RideHailingChat>, Message<RideHailingChat>, useChat<RideHailingChat>
```

All generics default to `DefaultDomain` (fully open `string` / `Record<string, unknown>`) so existing code without generics continues to work.

**Zod schemas remain ungeneric** — they validate at runtime with loose types. Generics are compile-time only.

## File Map

| File | Contents |
|------|----------|
| `src/index.ts` | Re-exports all types and schemas |
| `src/domain.ts` | `ChatDomain` interface, `DefaultDomain` |
| `src/participant.ts` | `Participant<D>`, `participantSchema` |
| `src/message.ts` | `Message<D>`, `MessageAttributes<D>`, `SendMessageRequest<D>`, request/response types, Zod schemas |
| `src/channel.ts` | `JoinRequest`, `JoinResponse<D>`, `joinRequestSchema` |
| `src/sse.ts` | `SSEMessageEvent<D>`, `SSEEvent<D>` |
| `src/manifest.ts` | `ChatManifest`, `ChatBucket` for bucket routing |

## Conventions

- Every generic interface defaults to `DefaultDomain` — consumer code without explicit generics works unchanged
- Participant `role` is constrained by `D['role']`, not a hardcoded enum
- Participant `metadata` is constrained by `D['metadata']` for domain-specific data
- Message `sender_role` is `D['role'] | 'system'` — system messages always valid
- Message `type` is constrained by `D['messageType']`
- Message `attributes` is constrained by `D['attributes']`
- Zod schemas use loose runtime types (`z.string()`, `z.record(z.unknown())`)
- Types are exported via `export type` from `index.ts`; schemas via `export`

## Adding a New Type

1. Add interface/schema to the relevant file (or create new file)
2. If domain-specific, parameterize with `<D extends ChatDomain = DefaultDomain>`
3. Re-export from `src/index.ts`
4. Run `bunx tsc --noEmit` from repo root to verify
5. Update this AGENTS.md file map if you added a new file
