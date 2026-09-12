export type StreamReadResult =
  | { done: true; value?: undefined }
  | { done: false; value: Uint8Array };

type Waiter = {
  resolve: (result: StreamReadResult) => void;
  reject: (error: Error) => void;
};

export class PullByteQueue {
  private readonly chunks: Uint8Array[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;
  private error: Error | null = null;

  push(chunk: Uint8Array): void {
    if (this.closed || this.error || chunk.byteLength === 0) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: chunk });
      return;
    }
    this.chunks.push(chunk);
  }

  close(): void {
    if (this.closed || this.error) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters) {
      waiter.resolve({ done: true, value: undefined });
    }
    this.waiters.length = 0;
  }

  fail(error: Error): void {
    if (this.closed || this.error) {
      return;
    }
    this.error = error;
    this.chunks.length = 0;
    for (const waiter of this.waiters) {
      waiter.reject(error);
    }
    this.waiters.length = 0;
  }

  getReader() {
    return {
      read: () => this.read(),
      cancel: async () => {
        this.chunks.length = 0;
        this.close();
      },
      releaseLock() {},
    };
  }

  private read(): Promise<StreamReadResult> {
    if (this.error) {
      return Promise.reject(this.error);
    }
    if (this.chunks.length) {
      return Promise.resolve({ done: false, value: this.chunks.shift() });
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}
