# Types Reference

Complete reference for all types, interfaces, and Zod schemas exported by `@pedi/chika-types`.

## Table of Contents

- [Core Types](#core-types)
  - [ChatDomain](#chatdomain)
  - [DefaultDomain](#defaultdomain)
  - [Participant\<D\>](#participantd)
  - [Message\<D\>](#messaged)
  - [MessageAttributes\<D\>](#messageattributesd)
- [Request Types](#request-types)
  - [SendMessageRequest\<D\>](#sendmessagerequestd)
  - [SystemMessageRequest\<D\>](#systemmessagerequestd)
  - [JoinRequest](#joinrequest)
- [Response Types](#response-types)
  - [SendMessageResponse](#sendmessageresponse)
  - [JoinResponse\<D\>](#joinresponsed)
  - [MessageHistoryQuery](#messagehistoryquery)
  - [MessageHistoryResponse\<D\>](#messagehistoryresponsed)
- [SSE Types](#sse-types)
  - [SSEMessageEvent\<D\>](#ssemessageeventd)
  - [SSEResyncEvent](#sseressyncevent)
  - [SSEEvent\<D\>](#sseeventd)
- [Manifest Types](#manifest-types)
  - [ChatBucket](#chatbucket)
  - [ChatManifest](#chatmanifest)
- [Pedi Domain Types](#pedi-domain-types)
  - [PediChat](#pedichat)
  - [PediRole](#pedirole)
  - [PediMessageType](#pedimessagetype)
  - [PediVehicle](#pedivehicle)
  - [PediLocation](#pedilocation)
  - [PediParticipantMeta](#pediparticipantmeta)
  - [PediMessageAttributes](#pedimessageattributes)
- [Zod Schemas](#zod-schemas)

---

## Core Types

### ChatDomain

The base interface that all chat domains must extend. Defines the shape of roles, metadata, message types, and attributes for a specific chat use case.

```typescript
interface ChatDomain {
  role: string;
  metadata: Record<string, unknown>;
  messageType: string;
  attributes: Record<string, unknown>;
}
```

| Property | Purpose |
|----------|---------|
| `role` | Union of valid participant roles (e.g. `'driver' \| 'rider'`) |
| `metadata` | Shape of participant metadata (e.g. vehicle info, rating) |
| `messageType` | Union of valid message types (e.g. `'chat' \| 'driver_arrived'`) |
| `attributes` | Shape of message attributes (e.g. location, device info) |

### DefaultDomain

The fallback domain used when no generic parameter is provided. All fields are maximally permissive.

```typescript
interface DefaultDomain extends ChatDomain {
  role: string;
  metadata: Record<string, unknown>;
  messageType: string;
  attributes: Record<string, unknown>;
}
```

---

### Participant\<D\>

Represents a user participating in a chat channel.

```typescript
interface Participant<D extends ChatDomain = DefaultDomain> {
  id: string;
  role: D['role'];
  name: string;
  profile_image?: string;
  metadata?: D['metadata'];
}
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `id` | `string` | Yes | Min 1 char | Unique participant identifier |
| `role` | `D['role']` | Yes | Min 1 char | Participant's role, constrained by domain |
| `name` | `string` | Yes | Min 1 char | Display name |
| `profile_image` | `string` | No | Valid URL | Avatar/profile picture URL |
| `metadata` | `D['metadata']` | No | Domain-specific | Extensible data (vehicle, rating, etc.) |

---

### Message\<D\>

A chat message within a channel.

```typescript
interface Message<D extends ChatDomain = DefaultDomain> {
  id: string;
  channel_id: string;
  sender_id: string | null;
  sender_role: D['role'] | 'system';
  type: D['messageType'];
  body: string;
  attributes: MessageAttributes<D>;
  created_at: string;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique message ID (`msg_<ULID>` format) |
| `channel_id` | `string` | Yes | Channel this message belongs to |
| `sender_id` | `string \| null` | Yes | Participant ID of sender; `null` for system messages |
| `sender_role` | `D['role'] \| 'system'` | Yes | Role of the sender; `'system'` is always valid regardless of domain |
| `type` | `D['messageType']` | Yes | Message type, constrained by domain |
| `body` | `string` | Yes | Message content |
| `attributes` | `MessageAttributes<D>` | Yes | Message metadata, constrained by domain |
| `created_at` | `string` | Yes | ISO 8601 timestamp |

---

### MessageAttributes\<D\>

Type alias that maps to `D['attributes']` from the domain definition.

```typescript
type MessageAttributes<D extends ChatDomain = DefaultDomain> = D['attributes'];
```

---

## Request Types

### SendMessageRequest\<D\>

Request body for sending a message as a participant.

```typescript
interface SendMessageRequest<D extends ChatDomain = DefaultDomain> {
  sender_id: string;
  type: D['messageType'];
  body: string;
  attributes?: MessageAttributes<D>;
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `sender_id` | `string` | Yes | Min 1 char. Must match an existing participant. |
| `type` | `D['messageType']` | Yes | Min 1 char |
| `body` | `string` | Yes | 1 - 10,000 characters |
| `attributes` | `MessageAttributes<D>` | No | Domain-constrained |

---

### SystemMessageRequest\<D\>

Request body for injecting a system message (no sender). Used by internal endpoints.

```typescript
interface SystemMessageRequest<D extends ChatDomain = DefaultDomain> {
  type: D['messageType'];
  body: string;
  attributes?: MessageAttributes<D>;
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `type` | `D['messageType']` | Yes | Min 1 char |
| `body` | `string` | Yes | 1 - 10,000 characters |
| `attributes` | `MessageAttributes<D>` | No | Domain-constrained |

---

### JoinRequest

Type alias for `Participant` — validated with `participantSchema`. Used as the request body for the join endpoint.

```typescript
type JoinRequest = z.infer<typeof joinRequestSchema>;
// Equivalent to: { id: string; role: string; name: string; profile_image?: string; metadata?: Record<string, unknown> }
```

---

## Response Types

### SendMessageResponse

Returned after successfully sending a message.

```typescript
interface SendMessageResponse {
  id: string;
  created_at: string;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Generated message ID (`msg_<ULID>`) |
| `created_at` | `string` | ISO 8601 timestamp |

---

### JoinResponse\<D\>

Returned after successfully joining a channel.

```typescript
interface JoinResponse<D extends ChatDomain = DefaultDomain> {
  channel_id: string;
  status: 'active' | 'closed';
  participants: Participant<D>[];
  messages: Message<D>[];
  joined_at: string;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `channel_id` | `string` | The joined channel's ID |
| `status` | `'active' \| 'closed'` | Current channel status |
| `participants` | `Participant<D>[]` | All participants currently in the channel |
| `messages` | `Message<D>[]` | Up to 50 most recent messages for context |
| `joined_at` | `string` | ISO 8601 timestamp of when this participant joined |

---

### MessageHistoryQuery

Query parameters for paginated message history.

```typescript
interface MessageHistoryQuery {
  limit?: number;
  before?: string;
  after?: string;
}
```

| Field | Type | Required | Constraints | Default |
|-------|------|----------|-------------|---------|
| `limit` | `number` | No | 1 - 200, positive integer | 50 |
| `before` | `string` | No | ISO 8601 datetime | — |
| `after` | `string` | No | ISO 8601 datetime | — |

The `limit` value is coerced from string to number (for query parameter parsing).

---

### MessageHistoryResponse\<D\>

Paginated message history result.

```typescript
interface MessageHistoryResponse<D extends ChatDomain = DefaultDomain> {
  channel_id: string;
  participants: Participant<D>[];
  messages: Message<D>[];
  has_more: boolean;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `channel_id` | `string` | Channel ID |
| `participants` | `Participant<D>[]` | All channel participants |
| `messages` | `Message<D>[]` | Messages in the requested page |
| `has_more` | `boolean` | `true` if more messages exist beyond this page |

---

## SSE Types

### SSEMessageEvent\<D\>

A real-time message event delivered over SSE.

```typescript
interface SSEMessageEvent<D extends ChatDomain = DefaultDomain> {
  id: string;
  event: 'message';
  data: Message<D>;
}
```

### SSEResyncEvent

Signals that the client should discard local state and re-join.

```typescript
interface SSEResyncEvent {
  event: 'resync';
  data: {
    reason: string;
    missed_count: number;
  };
}
```

### SSEEvent\<D\>

Union of all possible SSE event types.

```typescript
type SSEEvent<D extends ChatDomain = DefaultDomain> = SSEMessageEvent<D> | SSEResyncEvent;
```

---

## Manifest Types

### ChatBucket

A single routing bucket that maps a hash range to a server URL.

```typescript
interface ChatBucket {
  group: string;
  range: [number, number];
  server_url: string;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `group` | `string` | Logical group name for this bucket |
| `range` | `[number, number]` | Inclusive hash range `[min, max]` (0-99) |
| `server_url` | `string` | Base URL of the server handling this range |

### ChatManifest

Collection of buckets that together cover the full hash space.

```typescript
interface ChatManifest {
  buckets: ChatBucket[];
}
```

---

## Pedi Domain Types

Pre-built domain implementation for the Pedi ride-hailing chat system. 
Note: If you aren't a Pedi developer, this is highly irrelevant to you and you should 
probably just ignore this.

### PediChat

```typescript
interface PediChat extends ChatDomain {
  role: PediRole;
  metadata: PediParticipantMeta;
  messageType: PediMessageType;
  attributes: PediMessageAttributes;
}
```

### PediRole

```typescript
type PediRole = 'driver' | 'rider';
```

### PediMessageType

```typescript
type PediMessageType =
  | 'chat'
  | 'driver_arrived'
  | 'booking_started'
  | 'booking_completed'
  | 'booking_cancelled'
  | 'system_notice';
```

### PediVehicle

```typescript
interface PediVehicle {
  plate_number: string;
  body_number: string;
  color: string;
  brand: string;
}
```

### PediLocation

```typescript
interface PediLocation {
  latitude: number;
  longitude: number;
}
```

### PediParticipantMeta

```typescript
interface PediParticipantMeta {
  vehicle?: PediVehicle;
  rating?: number;
  current_location?: PediLocation | null;
  [key: string]: unknown;  // Extensible
}
```

### PediMessageAttributes

```typescript
interface PediMessageAttributes {
  location?: PediLocation;
  device?: 'android' | 'ios';
  app_version?: string;
  booking_id?: string;
  booking_status?: string;
  [key: string]: unknown;  // Extensible
}
```

---

## Zod Schemas

All schemas perform **loose runtime validation**. Domain-specific type safety is enforced at compile time through generics, not at runtime through Zod.

### participantSchema

```typescript
z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  name: z.string().min(1),
  profile_image: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
})
```

### joinRequestSchema

Reuses `participantSchema` — validates the same fields.

### sendMessageRequestSchema

```typescript
z.object({
  sender_id: z.string().min(1),
  type: z.string().min(1),
  body: z.string().min(1).max(10_000),
  attributes: messageAttributesSchema.optional(),
})
```

### systemMessageRequestSchema

```typescript
z.object({
  type: z.string().min(1),
  body: z.string().min(1).max(10_000),
  attributes: messageAttributesSchema.optional(),
})
```

### messageAttributesSchema

```typescript
z.object({}).catchall(z.unknown())
```

An open record that accepts any key-value pairs. Used as a sub-schema in message request schemas.

### messageHistoryQuerySchema

```typescript
z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
})
```

Note: `limit` uses `z.coerce.number()` because query parameters arrive as strings.
