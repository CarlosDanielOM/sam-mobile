export type NsBodyResponse = Response & {
  _bodyText?: string;
  _bodyBlob?: { arrayBuffer(): Promise<ArrayBuffer | Uint8Array> };
  _bodyArrayBuffer?: ArrayBuffer | Uint8Array;
};

function asBytes(value: ArrayBuffer | Uint8Array | ArrayBufferView): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export async function readResponseBytes(response: NsBodyResponse): Promise<Uint8Array> {
  if (response._bodyArrayBuffer) {
    return asBytes(response._bodyArrayBuffer);
  }
  if (response._bodyBlob && typeof response._bodyBlob.arrayBuffer === 'function') {
    return asBytes(await response._bodyBlob.arrayBuffer());
  }
  if (typeof response._bodyText === 'string') {
    return new TextEncoder().encode(response._bodyText);
  }
  return new TextEncoder().encode(await response.text());
}

export function attachBodyStream(response: Response): Response {
  if (response.body) {
    return response;
  }
  let pending: Promise<Uint8Array> | undefined;
  const body = {
    getReader() {
      let sent = false;
      return {
        async read() {
          if (sent) {
            return { done: true as const, value: undefined };
          }
          sent = true;
          pending ??= readResponseBytes(response);
          return { done: false as const, value: await pending };
        },
        async cancel() {
          sent = true;
        },
      };
    },
  };
  Object.defineProperty(response, 'body', {
    configurable: true,
    value: body,
  });
  return response;
}
