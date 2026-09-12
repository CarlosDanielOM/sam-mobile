export function formBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  if (typeof (body as { append?: unknown }).append !== 'function') {
    return null;
  }
  if (typeof (body as { toString?: unknown }).toString !== 'function') {
    return null;
  }
  const name = (body as { constructor?: { name?: string } }).constructor?.name;
  if (name === 'FormData' || name === 'Blob') {
    return null;
  }
  return String(body);
}
