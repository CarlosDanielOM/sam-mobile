import type { TransportResponse } from './types';

export class StreamResponse {
  readonly type = 'default';
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: { getReader: TransportResponse['body']['getReader'] };
  bodyUsed = false;

  constructor(result: TransportResponse) {
    this.ok = result.status >= 200 && result.status < 300;
    this.status = result.status;
    this.statusText = result.statusText;
    this.url = result.url;
    this.headers = new Headers(result.headers);
    this.body = result.body;
  }

  async text(): Promise<string> {
    this.bodyUsed = true;
    const reader = this.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        text += decoder.decode(value, { stream: true });
      }
    }
    return text + decoder.decode();
  }

  json(): Promise<unknown> {
    return this.text().then((text) => JSON.parse(text));
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    this.bodyUsed = true;
    const reader = this.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
        size += value.byteLength;
      }
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out.buffer;
  }
}
