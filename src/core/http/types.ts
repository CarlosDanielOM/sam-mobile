import type { PullByteQueue } from './byte-queue';

export type NormalizedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
};

export type TransportResponse = {
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  body: PullByteQueue;
  abort: () => void;
};

export type HttpTransport = {
  start(request: NormalizedRequest): Promise<TransportResponse>;
};
