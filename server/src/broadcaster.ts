import type { Message } from '@pedi/chika-types';
import type { SSEStreamingApi } from 'hono/streaming';

interface Connection {
  stream: SSEStreamingApi;
}

const channelConnections = new Map<string, Set<Connection>>();

export function subscribe(channelId: string, stream: SSEStreamingApi): Connection {
  const conn: Connection = { stream };

  let connections = channelConnections.get(channelId);
  if (!connections) {
    connections = new Set();
    channelConnections.set(channelId, connections);
  }
  connections.add(conn);

  return conn;
}

export function unsubscribe(channelId: string, conn: Connection): void {
  const connections = channelConnections.get(channelId);
  if (!connections) return;

  connections.delete(conn);
  if (connections.size === 0) {
    channelConnections.delete(channelId);
  }
}

export async function broadcast(channelId: string, message: Message): Promise<void> {
  const connections = channelConnections.get(channelId);
  if (!connections || connections.size === 0) return;

  const payload = JSON.stringify(message);
  const conns = [...connections];

  const results = await Promise.allSettled(
    conns.map((conn) =>
      conn.stream.writeSSE({ id: message.id, event: 'message', data: payload }),
    ),
  );

  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      connections.delete(conns[i]!);
    }
  }

  if (connections.size === 0) {
    channelConnections.delete(channelId);
  }
}

export async function disconnectChannel(channelId: string): Promise<void> {
  const connections = channelConnections.get(channelId);
  if (!connections) return;

  await Promise.allSettled(
    [...connections].map((conn) => {
      try {
        return conn.stream.close();
      } catch {
        return Promise.resolve();
      }
    }),
  );

  channelConnections.delete(channelId);
}

export function getAllChannelIds(): IterableIterator<string> {
  return channelConnections.keys();
}

export function getConnectionCount(channelId: string): number {
  return channelConnections.get(channelId)?.size ?? 0;
}
