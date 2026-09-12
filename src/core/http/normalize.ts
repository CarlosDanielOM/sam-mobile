import { formBody } from './form-body';
import type { NormalizedRequest } from './types';

export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof Request) {
    return input.url;
  }
  return String(input);
}

export function normalizeRequest(input: RequestInfo | URL, init?: RequestInit): NormalizedRequest {
  const request = input instanceof Request ? input : undefined;
  const headers = new Headers(request?.headers);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }

  let body: unknown = init?.body ?? (request as { _bodyInit?: unknown } | undefined)?._bodyInit;
  const encoded = formBody(body);
  if (encoded !== null) {
    body = encoded;
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    }
  }

  const headerMap: Record<string, string> = {};
  headers.forEach((value, key) => {
    headerMap[key] = value;
  });

  let normalizedBody: string | Uint8Array | undefined;
  if (typeof body === 'string' || body instanceof Uint8Array) {
    normalizedBody = body;
  } else if (body instanceof ArrayBuffer) {
    normalizedBody = new Uint8Array(body);
  } else if (body == null) {
    normalizedBody = undefined;
  } else {
    normalizedBody = String(body);
  }

  return {
    url: requestUrl(input),
    method: (init?.method ?? request?.method ?? 'GET').toUpperCase(),
    headers: headerMap,
    body: normalizedBody,
    signal: init?.signal ?? request?.signal ?? undefined,
  };
}
