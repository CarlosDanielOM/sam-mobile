export function copyJavaBytes(bytes: ArrayLike<number>, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = bytes[i] & 0xff;
  }
  return out;
}
