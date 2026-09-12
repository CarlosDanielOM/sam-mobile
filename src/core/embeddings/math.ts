/** Scaled sum of squares avoids intermediate overflow/underflow. */
export function norm(vector: readonly number[]): number {
  if (!vector.length) throw new RangeError('A nonempty finite vector is required.');
  let scale = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new RangeError('A nonempty finite vector is required.');
    scale = Math.max(scale, Math.abs(value));
  }
  if (scale === 0) return 0;
  let squares = 0;
  for (const value of vector) squares += (value / scale) ** 2;
  return scale * Math.sqrt(squares);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new RangeError('Vector dimensions must match.');
  // Normalize by each maximum first, including vectors whose norm exceeds MAX_VALUE.
  norm(a);
  norm(b);
  let aScale = 0;
  let bScale = 0;
  for (let i = 0; i < a.length; i++) {
    aScale = Math.max(aScale, Math.abs(a[i]));
    bScale = Math.max(bScale, Math.abs(b[i]));
  }
  if (!aScale || !bScale) throw new RangeError('Cosine requires nonzero vectors.');
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] / aScale;
    const y = b[i] / bScale;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(aa) / Math.sqrt(bb)));
}

export interface Statistics {
  count: number;
  total: number;
  mean: number | null;
  median: number | null;
  /** Nearest-rank percentile, not an interpolated estimate. */
  p95: number | null;
}

export function statistics(values: readonly number[]): Statistics {
  for (const value of values) if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('Measurements must be finite and nonnegative.');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total)) throw new RangeError('Measurement total overflow.');
  return {
    count, total,
    mean: count ? total / count : null,
    median: count ? (sorted[Math.floor((count - 1) / 2)] / 2 + sorted[Math.floor(count / 2)] / 2) : null,
    p95: count ? sorted[Math.ceil(count * 0.95) - 1] : null,
  };
}
