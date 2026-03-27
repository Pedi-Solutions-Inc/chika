import type { ChatStatus } from './types';

export class ChatDisconnectedError extends Error {
  constructor(public readonly status: ChatStatus) {
    super(`Cannot send message while ${status}`);
    this.name = 'ChatDisconnectedError';
  }
}

export class ChannelClosedError extends Error {
  constructor(public readonly channelId: string) {
    super(`Channel ${channelId} is closed`);
    this.name = 'ChannelClosedError';
  }
}
