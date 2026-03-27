export interface ChatDomain {
  role: string;
  metadata: Record<string, unknown>;
  messageType: string;
  attributes: Record<string, unknown>;
}

export interface DefaultDomain extends ChatDomain {
  role: string;
  metadata: Record<string, unknown>;
  messageType: string;
  attributes: Record<string, unknown>;
}
