import { isAndroid } from '@nativescript/core';
import { attachBodyStream } from '../response-body';
import { createOkHttpTransport } from './android-okhttp';
import { createStreamingFetch } from './create-fetch';
import { formBody } from './form-body';
import { withAuthRetry } from './retry';

function patchXhrSend(): void {
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const encoded = formBody(body);
    return xhrSend.call(this, encoded ?? body);
  };
}

function createXhrFetch(nativeFetch: typeof fetch): typeof fetch {
  return async (input, init) => attachBodyStream(await nativeFetch(input, init));
}

export function installHttpAdapter(): void {
  patchXhrSend();
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const fetchImpl = isAndroid
    ? createStreamingFetch(createOkHttpTransport())
    : createXhrFetch(nativeFetch);
  globalThis.fetch = withAuthRetry(fetchImpl);
}
