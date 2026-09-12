import { Utils } from '@nativescript/core';
import { PullByteQueue } from './byte-queue';
import { copyJavaBytes } from './java-bytes';
import type { HttpTransport, NormalizedRequest, TransportResponse } from './types';

declare const okhttp3: any;
declare const java: any;
declare const org: any;

function javaByteArray(length: number): any {
  return (Array as unknown as { create(type: string, length: number): any }).create('byte', length);
}

const CONNECT_TIMEOUT_SEC = 30;
const WRITE_TIMEOUT_SEC = 60;

let sharedClient: any;

function client(): any {
  if (!sharedClient) {
    const builder = new okhttp3.OkHttpClient.Builder();
    const unit = java.util.concurrent.TimeUnit.SECONDS;
    builder.connectTimeout(CONNECT_TIMEOUT_SEC, unit);
    builder.readTimeout(0, unit);
    builder.writeTimeout(WRITE_TIMEOUT_SEC, unit);
    builder.retryOnConnectionFailure(true);
    sharedClient = builder.build();
  }
  return sharedClient;
}

function onJs(fn: () => void): void {
  Utils.executeOnMainThread(fn);
}

function requestBody(request: NormalizedRequest): any {
  if (request.body == null || request.method === 'GET' || request.method === 'HEAD') {
    return null;
  }
  const contentType = request.headers['content-type'] ?? request.headers['Content-Type'] ?? null;
  const mediaType = contentType ? okhttp3.MediaType.parse(contentType) : null;
  if (typeof request.body === 'string') {
    return okhttp3.RequestBody.create(mediaType, request.body);
  }
  const bytes = javaByteArray(request.body.byteLength);
  for (let i = 0; i < request.body.byteLength; i++) {
    bytes[i] = request.body[i];
  }
  return okhttp3.RequestBody.create(mediaType, bytes);
}

function startPump(call: any, response: any, queue: PullByteQueue): void {
  org.nativescript.nativesam.http.StreamPump.start(
    call,
    response,
    new org.nativescript.nativesam.http.StreamPumpListener({
      onBytes(chunk: ArrayLike<number> & { length: number }) {
        const bytes = copyJavaBytes(chunk, chunk.length);
        onJs(() => queue.push(bytes));
      },
      onEnd() {
        onJs(() => queue.close());
      },
      onError(message: string) {
        onJs(() => queue.fail(new Error(message || 'Stream failed')));
      },
    }),
  );
}

export function createOkHttpTransport(): HttpTransport {
  const http = client();
  return {
    start(request: NormalizedRequest): Promise<TransportResponse> {
      return new Promise((resolve, reject) => {
        const builder = new okhttp3.Request.Builder().url(request.url);
        for (const [key, value] of Object.entries(request.headers)) {
          builder.header(key, value);
        }
        builder.method(request.method, requestBody(request));
        const call = http.newCall(builder.build());
        call.enqueue(
          new okhttp3.Callback({
            onFailure(_call: any, error: any) {
              const message = error?.message ?? String(error);
              onJs(() => reject(new TypeError(`Network request failed: ${message}`)));
            },
            onResponse(_call: any, response: any) {
              onJs(() => {
                try {
                  const queue = new PullByteQueue();
                  const headers: Record<string, string> = {};
                  const nativeHeaders = response.headers();
                  for (let i = 0; i < nativeHeaders.size(); i++) {
                    headers[nativeHeaders.name(i)] = nativeHeaders.value(i);
                  }
                  resolve({
                    status: response.code(),
                    statusText: String(response.message() ?? ''),
                    url: String(response.request().url()),
                    headers,
                    body: queue,
                    abort: () => call.cancel(),
                  });
                  startPump(call, response, queue);
                } catch (error) {
                  try {
                    response.close();
                  } catch {}
                  reject(error);
                }
              });
            },
          }),
        );
      });
    },
  };
}
