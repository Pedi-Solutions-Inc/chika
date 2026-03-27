# @pedi/chika-types

Shared TypeScript types and Zod validation schemas for the Pedi Chika chat system.

## What It Does

Provides the single source of truth for all data structures in the chat system. Every message, participant, channel event, and API request/response is defined here and shared across both the server and the SDK.

## Problems It Solves

- **Type drift between client and server** — A single package defines the contract, so the SDK and server can never disagree on the shape of a message or participant
- **Runtime validation** — Zod schemas validate incoming data at API boundaries while TypeScript generics enforce correctness at compile time
- **Domain flexibility** — The generic `ChatDomain` system lets you reuse the entire type system for different chat contexts (ride-hailing, customer support, etc.) with full type safety

## Key Features

- Generic `ChatDomain` interface for defining strongly-typed chat domains
- Pre-built `PediChat` domain for ride-hailing (driver/rider roles, booking events, vehicle metadata)
- Zod schemas for all API request validation (participants, messages, history queries)
- Full TypeScript generics — `Message<PediChat>`, `Participant<PediChat>`, etc.
- Zero dependencies beyond Zod

## Quick Start

```typescript
import type { Message, Participant, PediChat } from '@pedi/chika-types';
import { sendMessageRequestSchema } from '@pedi/chika-types';

// Strongly typed for ride-hailing
const msg: Message<PediChat> = { /* autocomplete guides you */ };

// Runtime validation at API boundaries
const parsed = sendMessageRequestSchema.parse(requestBody);
```

## Documentation

See the [docs](./docs/) for detailed documentation:

- [Type Reference](./docs/type-reference.md) — All types, interfaces, and schemas
- [Chat Domain Guide](./docs/chat-domain-guide.md) — How the generic domain system works, with examples
