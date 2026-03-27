# Chat Domain Guide

The `ChatDomain` generic system is the foundation of Pedi Chika's type safety. It lets you define a single domain interface that flows through every type in the system — messages, participants, requests, and responses all become strongly typed for your specific use case.

## How It Works

### The ChatDomain Interface

Every chat domain is defined by four properties:

```typescript
interface ChatDomain {
  role: string;                        // Who can participate
  metadata: Record<string, unknown>;   // What data participants carry
  messageType: string;                 // What kinds of messages exist
  attributes: Record<string, unknown>; // What metadata messages carry
}
```

### Generic Propagation

When you define a domain, those four properties propagate through all related types:

```typescript
interface MyDomain extends ChatDomain {
  role: 'agent' | 'customer';
  metadata: { department?: string };
  messageType: 'chat' | 'escalation';
  attributes: { priority?: number };
}

// Now these types are all constrained:
Participant<MyDomain>     // role must be 'agent' | 'customer'
Message<MyDomain>         // type must be 'chat' | 'escalation'
SendMessageRequest<MyDomain>  // body, type, attributes all typed
JoinResponse<MyDomain>    // messages and participants are typed
```

### DefaultDomain Fallback

If you don't provide a generic parameter, all types fall back to `DefaultDomain`:

```typescript
// These are equivalent:
const msg: Message = { ... };
const msg: Message<DefaultDomain> = { ... };

// DefaultDomain allows any string for role, messageType, etc.
```

This means existing code that doesn't use generics continues to work without changes.

## Defining a Custom Domain

### Step 1: Define the Domain Interface

```typescript
import type { ChatDomain } from '@pedi/chika-types';

interface SupportChat extends ChatDomain {
  role: 'agent' | 'customer' | 'supervisor';
  metadata: {
    department?: string;
    is_online?: boolean;
    handled_count?: number;
  };
  messageType: 'chat' | 'escalation' | 'resolved' | 'transferred' | 'system_notice';
  attributes: {
    priority?: 1 | 2 | 3;
    ticket_id?: string;
    resolution_code?: string;
  };
}
```

### Step 2: Use It Everywhere

```typescript
import type { Message, Participant, SendMessageRequest } from '@pedi/chika-types';

// Participants are typed
const agent: Participant<SupportChat> = {
  id: 'agent_001',
  role: 'agent',       // ✅ Must be 'agent' | 'customer' | 'supervisor'
  // role: 'admin',    // ❌ Type error!
  name: 'Maria',
  metadata: {
    department: 'billing',
    is_online: true,
  },
};

// Messages are typed
const msg: Message<SupportChat> = {
  id: 'msg_01HX...',
  channel_id: 'ticket_456',
  sender_id: 'agent_001',
  sender_role: 'agent',      // ✅ Must be 'agent' | 'customer' | 'supervisor' | 'system'
  type: 'escalation',        // ✅ Must be one of the defined message types
  // type: 'unknown_type',   // ❌ Type error!
  body: 'Escalating to supervisor',
  attributes: {
    priority: 1,              // ✅ Must be 1 | 2 | 3
    ticket_id: 'TK-789',
  },
  created_at: '2026-03-28T10:00:00.000Z',
};
```

### Step 3: Use with the SDK

```typescript
import { useChat } from '@pedi/chika-sdk';

// The hook is fully typed for your domain
const { messages, sendMessage } = useChat<SupportChat>({
  config: { /* ... */ },
  channelId: 'ticket_456',
  profile: agent,
});

// sendMessage only accepts valid types and attributes
await sendMessage('escalation', 'Need supervisor help', { priority: 1 });
// await sendMessage('invalid_type', '...'); // ❌ Type error!
```

## The Pedi Domain

The package ships with a pre-built `PediChat` domain for ride-hailing:

```typescript
interface PediChat extends ChatDomain {
  role: PediRole;                    // 'driver' | 'rider'
  metadata: PediParticipantMeta;     // vehicle, rating, location
  messageType: PediMessageType;      // chat, driver_arrived, booking_*, system_notice
  attributes: PediMessageAttributes; // location, device, booking_id, etc.
}
```

### Rider Example

```typescript
import type { Participant, PediChat } from '@pedi/chika-types';

const rider: Participant<PediChat> = {
  id: 'rider_123',
  role: 'rider',
  name: 'Juan dela Cruz',
  profile_image: 'https://example.com/juan.jpg',
  metadata: {
    rating: 4.9,
    current_location: { latitude: 14.5995, longitude: 120.9842 },
  },
};
```

### Driver Example

```typescript
const driver: Participant<PediChat> = {
  id: 'driver_456',
  role: 'driver',
  name: 'Pedro Santos',
  metadata: {
    vehicle: {
      plate_number: 'ABC 1234',
      body_number: '42',
      color: 'White',
      brand: 'Honda Click',
    },
    rating: 4.8,
    current_location: { latitude: 14.6010, longitude: 120.9850 },
  },
};
```

### Message Examples

```typescript
import type { Message, PediChat } from '@pedi/chika-types';

// Regular chat message
const chatMsg: Message<PediChat> = {
  id: 'msg_01HX...',
  channel_id: 'booking_789',
  sender_id: 'rider_123',
  sender_role: 'rider',
  type: 'chat',
  body: 'I am at the corner near 7-Eleven',
  attributes: {
    device: 'ios',
    app_version: '2.1.0',
    location: { latitude: 14.5995, longitude: 120.9842 },
  },
  created_at: '2026-03-28T10:00:00.000Z',
};

// Driver arrival event
const arrivalMsg: Message<PediChat> = {
  id: 'msg_01HX...',
  channel_id: 'booking_789',
  sender_id: 'driver_456',
  sender_role: 'driver',
  type: 'driver_arrived',
  body: 'I have arrived at the pickup point',
  attributes: {
    location: { latitude: 14.5995, longitude: 120.9842 },
    booking_id: 'bk_789',
  },
  created_at: '2026-03-28T10:02:00.000Z',
};

// System message (injected by backend)
const systemMsg: Message<PediChat> = {
  id: 'msg_01HX...',
  channel_id: 'booking_789',
  sender_id: null,
  sender_role: 'system',
  type: 'system_notice',
  body: 'Your booking has been completed. Thank you for riding with Pedi!',
  attributes: {
    booking_id: 'bk_789',
    booking_status: 'completed',
  },
  created_at: '2026-03-28T10:15:00.000Z',
};
```

## Design Decisions

### Why Generics Instead of Discriminated Unions?

Generics allow the domain to be defined once and flow through the entire type system. With discriminated unions, you'd need to manually narrow types at every usage point. Generics make the common case (working within a single domain) ergonomic.

### Why Are Zod Schemas Not Generic?

Zod schemas perform runtime validation at API boundaries. At runtime, a message type is just a string — there's no way to enforce domain constraints. The schemas validate structural correctness (is it a string? is it non-empty? is it under 10,000 chars?) while generics enforce domain correctness at compile time.

This split keeps schemas simple and reusable across all domains.

### Why Does `sender_role` Include `'system'`?

System messages (injected by backend services via internal endpoints) don't have a sender. Rather than making `sender_role` optional, the type includes `'system'` as an always-valid role. This ensures every message has a role for display purposes without requiring domain definitions to include a system role.

### Why Is `metadata` Optional on Participant?

Not all participants have domain-specific data. A rider might join with just an ID, role, and name. Making metadata optional prevents forcing callers to construct empty objects.
