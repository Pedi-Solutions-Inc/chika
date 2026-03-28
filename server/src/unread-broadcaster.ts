import type { SSEStreamingApi } from 'hono/streaming';

interface Connection {
  stream: SSEStreamingApi;
}

const connections = new Map<string, Set<Connection>>();
const channelParticipants = new Map<string, Set<string>>();

function key(channelId: string, participantId: string): string {
  return `${channelId}:${participantId}`;
}

export function subscribeUnread(
  channelId: string,
  participantId: string,
  stream: SSEStreamingApi,
): Connection {
  const conn: Connection = { stream };
  const k = key(channelId, participantId);

  let set = connections.get(k);
  if (!set) {
    set = new Set();
    connections.set(k, set);
  }
  set.add(conn);

  let participants = channelParticipants.get(channelId);
  if (!participants) {
    participants = new Set();
    channelParticipants.set(channelId, participants);
  }
  participants.add(participantId);

  return conn;
}

export function unsubscribeUnread(
  channelId: string,
  participantId: string,
  conn: Connection,
): void {
  const k = key(channelId, participantId);
  const set = connections.get(k);
  if (!set) return;

  set.delete(conn);
  if (set.size === 0) {
    connections.delete(k);
    const participants = channelParticipants.get(channelId);
    if (participants) {
      participants.delete(participantId);
      if (participants.size === 0) {
        channelParticipants.delete(channelId);
      }
    }
  }
}

export async function broadcastToParticipant(
  channelId: string,
  participantId: string,
  event: string,
  data: unknown,
): Promise<void> {
  const k = key(channelId, participantId);
  const set = connections.get(k);
  if (!set || set.size === 0) return;

  const payload = JSON.stringify(data);
  const conns = [...set];

  const results = await Promise.allSettled(
    conns.map((conn) => conn.stream.writeSSE({ event, data: payload })),
  );

  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      set.delete(conns[i]!);
    }
  }

  if (set.size === 0) {
    connections.delete(k);
    const participants = channelParticipants.get(channelId);
    if (participants) {
      participants.delete(participantId);
      if (participants.size === 0) {
        channelParticipants.delete(channelId);
      }
    }
  }
}

export async function broadcastToChannel(
  channelId: string,
  excludeParticipantId: string | null,
  event: string,
  data: unknown,
): Promise<void> {
  const participants = channelParticipants.get(channelId);
  if (!participants) return;

  const tasks: Promise<void>[] = [];
  for (const participantId of participants) {
    if (participantId === excludeParticipantId) continue;
    tasks.push(broadcastToParticipant(channelId, participantId, event, data));
  }

  await Promise.allSettled(tasks);
}
