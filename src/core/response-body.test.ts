import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachBodyStream, readResponseBytes } from './response-body.ts';

function nsResponse(init: {
  body?: ReadableStream<Uint8Array> | null;
  _bodyText?: string;
  _bodyBlob?: { arrayBuffer(): Promise<ArrayBuffer | Uint8Array> };
  _bodyArrayBuffer?: ArrayBuffer | Uint8Array;
}): Response {
  const response = {
    ok: true,
    status: 200,
    body: init.body,
    _bodyText: init._bodyText,
    _bodyBlob: init._bodyBlob,
    _bodyArrayBuffer: init._bodyArrayBuffer,
    async text() {
      return init._bodyText ?? '';
    },
  };
  return response as unknown as Response;
}

async function readAll(response: Response): Promise<string> {
  if (!response.body) {
    throw new Error('No response body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

test('NativeScript-like Response has no body stream', () => {
  const response = nsResponse({ _bodyText: 'data: hi\n\n' });
  assert.equal(response.body, undefined);
  assert.throws(() => {
    if (!response.body) {
      throw new Error('No response body');
    }
  }, /No response body/);
});

test('attachBodyStream exposes bytes from _bodyText', async () => {
  const sse = 'event: response.output_text.delta\ndata: {"delta":"hello"}\n\n';
  const response = attachBodyStream(nsResponse({ _bodyText: sse }));
  assert.equal(await readAll(response), sse);
});

test('attachBodyStream exposes bytes from NS Blob arrayBuffer', async () => {
  const sse = 'data: {"type":"ok"}\n\n';
  const blob = {
    arrayBuffer: async () => new TextEncoder().encode(sse),
  };
  const response = attachBodyStream(nsResponse({ _bodyBlob: blob }));
  assert.equal(await readAll(response), sse);
});

test('readResponseBytes uses array buffer first', async () => {
  const bytes = new TextEncoder().encode('abc');
  const got = await readResponseBytes(
    nsResponse({ _bodyArrayBuffer: bytes, _bodyText: 'nope' }) as never,
  );
  assert.equal(new TextDecoder().decode(got), 'abc');
});
