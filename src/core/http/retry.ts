import { requestUrl } from './normalize';

function isNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /network request failed/i.test(message);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

const RETRYABLE_AUTH_HOSTS = ['auth.openai.com', 'auth.x.ai', 'auth.kimi.com'];

export function withAuthRetry(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    const retry = RETRYABLE_AUTH_HOSTS.some((host) => url.includes(host));
    const deadline = Date.now() + 15 * 60 * 1000;
    while (true) {
      try {
        return await fetchImpl(input, init);
      } catch (error) {
        if (!retry || init?.signal?.aborted || !isNetworkError(error) || Date.now() >= deadline) {
          const message = error instanceof Error ? error.message : String(error);
          throw new TypeError(`${message} (${url})`);
        }
        await wait(2000, init?.signal);
      }
    }
  };
}
