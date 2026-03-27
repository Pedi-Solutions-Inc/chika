export interface ChatBucket {
  group: string;
  range: [number, number];
  server_url: string;
}

export interface ChatManifest {
  buckets: ChatBucket[];
}
