import { normalizeRequest } from './normalize';
import { StreamResponse } from './stream-response';
import type { HttpTransport } from './types';

export function createStreamingFetch(transport: HttpTransport) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = normalizeRequest(input, init);
    if (request.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const result = await transport.start(request);
    if (request.signal) {
      const abort = () => result.abort();
      if (request.signal.aborted) {
        abort();
      } else {
        request.signal.addEventListener('abort', abort, { once: true });
      }
    }
    return new StreamResponse(result) as unknown as Response;
  };
}
