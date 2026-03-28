# Server API Reference

## Overview

The server exposes two groups of endpoints:

- **Client endpoints** (`/channels/*`) — Public-facing, used by the SDK and client apps. Rate-limited by IP.
- **Internal endpoints** (`/internal/channels/*`) — Authenticated with `X-Api-Key` header. Used by backend services to inject system messages, fetch history, and manage channels.

All request bodies are validated with Zod schemas from `@pedi/chika-types`. Validation errors return a 400 status with `{ error: string, details: object }`.

All timestamps are ISO 8601 strings (`YYYY-MM-DDTHH:mm:ss.sssZ`).

---

## Client Endpoints

### POST /channels/:channelId/join

Join a channel. Creates the channel automatically if it doesn't exist. If the participant already exists in the channel, their profile is updated (upserted).

**Request Body:**

```json
{
  "id": "user_123",
  "role": "rider",
  "name": "Juan dela Cruz",
  "profile_image": "https://example.com/avatar.jpg",
  "metadata": {
    "rating": 4.8,
    "current_location": { "latitude": 14.5995, "longitude": 120.9842 }
  }
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `id` | string | Yes | Min 1 character |
| `role` | string | Yes | Min 1 character |
| `name` | string | Yes | Min 1 character |
| `profile_image` | string | No | Must be a valid URL |
| `metadata` | object | No | Any key-value pairs |

**Success Response (200):**

```json
{
  "channel_id": "booking_456",
  "status": "active",
  "participants": [
    {
      "id": "user_123",
      "role": "rider",
      "name": "Juan dela Cruz",
      "profile_image": "https://example.com/avatar.jpg",
      "metadata": { "rating": 4.8 },
      "joined_at": "2026-03-28T10:00:00.000Z"
    },
    {
      "id": "driver_789",
      "role": "driver",
      "name": "Pedro Santos",
      "joined_at": "2026-03-28T09:55:00.000Z"
    }
  ],
  "messages": [
    {
      "id": "msg_01JQXYZ...",
      "channel_id": "booking_456",
      "sender_id": "driver_789",
      "sender_role": "driver",
      "type": "chat",
      "body": "On my way!",
      "attributes": {},
      "created_at": "2026-03-28T09:56:00.000Z"
    }
  ],
  "joined_at": "2026-03-28T10:00:00.000Z"
}
```

The response includes up to 50 most recent messages for immediate display.

**Error Responses:**

| Status | Body | Condition |
|--------|------|-----------|
| 400 | `{ "error": "Validation error", "details": {...} }` | Invalid request body |
| 410 | `{ "error": "Channel is closed" }` | Channel has been permanently closed |

---

### POST /channels/:channelId/messages

Send a message to a channel. The sender must be a participant (must have joined first).

**Request Body:**

```json
{
  "sender_id": "user_123",
  "type": "chat",
  "body": "Hello! Where are you?",
  "attributes": {
    "device": "ios",
    "app_version": "2.1.0",
    "location": { "latitude": 14.5995, "longitude": 120.9842 }
  },
  "idempotency_key": "optimistic_1711612860000_a3b5c"
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `sender_id` | string | Yes | Min 1 character. Must match an existing participant. |
| `type` | string | Yes | Min 1 character |
| `body` | string | Yes | 1 - 10,000 characters |
| `attributes` | object | No | Any key-value pairs |
| `idempotency_key` | string | No | 1-64 characters. Used for retry deduplication. If a message with the same channel + key already exists, the original message's response is returned. |

**Success Response (201):**

```json
{
  "id": "msg_01JQXYZ123ABC456DEF789",
  "created_at": "2026-03-28T10:01:00.000Z"
}
```

The message is persisted to MongoDB and broadcast to all connected SSE streams for this channel.

**Idempotency:** When `idempotency_key` is provided and a message with the same key already exists in this channel, the server returns the original message's `id` and `created_at` with status 201 — no duplicate message is created and no SSE broadcast occurs. This allows safe client retry without duplicate messages.

**Error Responses:**

| Status | Body | Condition |
|--------|------|-----------|
| 400 | `{ "error": "Validation error", "details": {...} }` | Invalid request body |
| 403 | `{ "error": "Sender is not a participant" }` | `sender_id` not found in channel participants |
| 404 | `{ "error": "Channel not found" }` | Channel does not exist |
| 410 | `{ "error": "Channel is closed" }` | Channel has been permanently closed |

---

### GET /channels/:channelId/stream

Opens a Server-Sent Events (SSE) stream for real-time message delivery.

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `since_time` | ISO 8601 string | No | Replay messages created after this timestamp |

**Request Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Last-Event-ID` | No | Message ID to resume from. Used for gap-fill after reconnection. |

**Behavior:**

1. If `Last-Event-ID` is provided:
   - Server looks up messages after that ID using ULID ordering
   - If the ID is found, missed messages are replayed as `message` events
   - If the ID is **not** found (too old, pruned), a `resync` event is sent instead
2. If `since_time` is provided, messages after that timestamp are replayed
3. The stream then delivers new messages in real-time as they arrive

**SSE Event Types:**

#### `message`

A new chat message. Includes an `id` field for `Last-Event-ID` tracking.

```
event: message
id: msg_01JQXYZ123ABC456DEF789
data: {"id":"msg_01JQXYZ123ABC456DEF789","channel_id":"booking_456","sender_id":"user_123","sender_role":"rider","type":"chat","body":"Hello!","attributes":{"device":"ios"},"created_at":"2026-03-28T10:01:00.000Z"}
```

#### `heartbeat`

Sent every 30 seconds to keep the connection alive. Does **not** include an `id` field to avoid resetting `Last-Event-ID` on the client.

```
event: heartbeat
data:
```

#### `resync`

Sent when the server cannot find the client's `Last-Event-ID` in the database. The client should discard local state and re-join the channel.

```
event: resync
data:
```

**Error Responses:**

| Status | Body | Condition |
|--------|------|-----------|
| 404 | `{ "error": "Channel not found" }` | Channel does not exist |
| 410 | `{ "error": "Channel is closed" }` | Channel has been permanently closed |

---

### GET /channels/:channelId/unread

Opens an SSE stream for real-time unread message notifications. Used to power "red dot" or badge count indicators on non-chat pages.

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `participant_id` | string | Yes | The participant to track unread messages for |

**Behavior:**

1. On connect, the server sends an `unread_snapshot` event with the current unread count
2. When a new message is sent to the channel by another participant, an `unread_update` event is delivered
3. When the participant's read cursor is updated (via `POST /read`), an `unread_clear` event is delivered
4. Heartbeats are sent every 30 seconds

**SSE Event Types:**

#### `unread_snapshot`

Sent on initial connection with the current unread state.

```
event: unread_snapshot
data: {"channel_id":"booking_456","unread_count":3,"last_message_at":"2026-03-28T10:05:00.000Z"}
```

#### `unread_update`

Sent when a new message arrives from another participant. Minimal payload — no message body.

```
event: unread_update
data: {"channel_id":"booking_456","message_id":"msg_01JQXYZ...","created_at":"2026-03-28T10:06:00.000Z"}
```

#### `unread_clear`

Sent when the read cursor is updated (e.g., after `POST /read` or joining the channel).

```
event: unread_clear
data: {"channel_id":"booking_456","unread_count":0}
```

#### `heartbeat`

Sent every 30 seconds. Same as the chat stream heartbeat.

**Passive Listening:**

The endpoint does not require the channel to exist or the participant to have joined. If the channel doesn't exist yet or the participant isn't in it, the server sends an `unread_snapshot` with count `0` and keeps the connection open. When the channel is created and messages arrive, `unread_update` events will be delivered in real-time. This enables use cases like showing unread indicators on a list page before the user has entered the chat.

**Error Responses:**

| Status | Body | Condition |
|--------|------|-----------|
| 400 | `{ "error": "participant_id query parameter is required" }` | Missing query parameter |
| 410 | `{ "error": "Channel is closed" }` | Channel has been permanently closed |

---

### POST /channels/:channelId/read

Mark messages as read for a participant. Advances the read cursor to the specified message ID. The cursor can only move forward — attempts to set it to an older message are ignored.

**Request Body:**

```json
{
  "participant_id": "user_123",
  "message_id": "msg_01JQXYZ123ABC456DEF789"
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `participant_id` | string | Yes | Min 1 character. Must match an existing participant. |
| `message_id` | string | Yes | Min 1 character. Must exist in the channel's messages. |

**Success Response (200):**

```json
{
  "success": true
}
```

After a successful mark-read, an `unread_clear` event is broadcast to the participant's unread SSE stream (if connected) with the updated count.

**Error Responses:**

| Status | Body | Condition |
|--------|------|-----------|
| 400 | `{ "error": "Invalid request", "details": {...} }` | Invalid request body |
| 403 | `{ "error": "Participant not found in channel" }` | Participant has not joined the channel |
| 404 | `{ "error": "Channel not found" }` | Channel does not exist |
| 404 | `{ "error": "Message not found in channel" }` | Message ID does not exist in this channel |

---

## Internal Endpoints

All internal endpoints require the `X-Api-Key` header. The key is validated using `crypto.timingSafeEqual` to prevent timing attacks.

```
X-Api-Key: your-secret-key
```

Missing or invalid keys return `401 Unauthorized`.

---

### POST /internal/channels/:channelId/messages

Inject a system message into a channel. System messages have `sender_id: null` and `sender_role: "system"`. They are broadcast to all connected SSE streams just like regular messages.

**Request Body:**

```json
{
  "type": "system_notice",
  "body": "Your booking has been completed. Thank you for riding with Pedi!",
  "attributes": {
    "booking_id": "bk_123",
    "booking_status": "completed"
  }
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `type` | string | Yes | Min 1 character |
| `body` | string | Yes | 1 - 10,000 characters |
| `attributes` | object | No | Any key-value pairs |

**Success Response (201):**

```json
{
  "id": "msg_01JQXYZ789GHI012JKL345",
  "created_at": "2026-03-28T10:05:00.000Z"
}
```

**Error Responses:**

| Status | Condition |
|--------|-----------|
| 401 | Missing or invalid API key |
| 404 | Channel not found |
| 410 | Channel is closed |

---

### GET /internal/channels/:channelId/messages

Fetch message history with cursor-based pagination. Messages are ordered by `created_at` descending (newest first).

**Query Parameters:**

| Param | Type | Default | Constraints | Description |
|-------|------|---------|-------------|-------------|
| `limit` | number | 50 | 1 - 200 | Max messages to return |
| `before` | ISO 8601 string | — | Valid datetime | Return messages created before this time (exclusive) |
| `after` | ISO 8601 string | — | Valid datetime | Return messages created after this time (exclusive) |

**Example Request:**

```
GET /internal/channels/booking_456/messages?limit=20&before=2026-03-28T10:00:00.000Z
```

**Success Response (200):**

```json
{
  "channel_id": "booking_456",
  "participants": [
    { "id": "user_123", "role": "rider", "name": "Juan", "joined_at": "2026-03-28T09:50:00.000Z" }
  ],
  "messages": [
    {
      "id": "msg_01JQXYZ...",
      "channel_id": "booking_456",
      "sender_id": "user_123",
      "sender_role": "rider",
      "type": "chat",
      "body": "Are you nearby?",
      "attributes": {},
      "created_at": "2026-03-28T09:58:00.000Z"
    }
  ],
  "has_more": true
}
```

Use `has_more` to determine if additional pages exist. Pass the `created_at` of the last message as the `before` parameter for the next page.

**Error Responses:**

| Status | Condition |
|--------|-----------|
| 401 | Missing or invalid API key |
| 404 | Channel not found |

---

### POST /internal/channels/:channelId/close

Permanently close a channel. All active SSE connections for the channel are immediately disconnected. Subsequent requests to join, send messages, or stream will return 410.

**Success Response (200):**

```json
{
  "channel_id": "booking_456",
  "status": "closed"
}
```

**Error Responses:**

| Status | Condition |
|--------|-----------|
| 401 | Missing or invalid API key |
| 404 | Channel not found |
| 410 | Channel already closed |

---

## Health Check

### GET /health

Pings MongoDB to verify database connectivity. No authentication required.

**Healthy (200):**
```json
{ "status": "ok" }
```

**Unhealthy (503):**
```json
{ "status": "unhealthy" }
```

---

## Rate Limits

IP-based rate limiting is applied to all client endpoints. The client IP is extracted from (in order of priority):

1. First value in `x-forwarded-for` header
2. `x-real-ip` header
3. Falls back to `"unknown"`

| Endpoint | Limit | Window |
|----------|-------|--------|
| `POST /channels/:channelId/join` | 120 requests | 60 seconds |
| `POST /channels/:channelId/messages` | 120 requests | 60 seconds |
| `GET /channels/:channelId/stream` | 30 requests | 60 seconds |
| `GET /channels/:channelId/unread` | 30 requests | 60 seconds |
| `POST /channels/:channelId/read` | 120 requests | 60 seconds |

When the limit is exceeded, the server returns `429 Too Many Requests`.

Internal endpoints are not rate-limited.

---

## Error Response Format

All error responses follow a consistent JSON structure:

```json
{
  "error": "Human-readable error message"
}
```

Validation errors include additional details:

```json
{
  "error": "Validation error",
  "details": {
    "formErrors": [],
    "fieldErrors": {
      "body": ["String must contain at least 1 character(s)"]
    }
  }
}
```

Unhandled server errors return:

```json
{
  "error": "Internal server error"
}
```

These are logged and reported to Sentry (if configured).
