/**
 * Unsigned LEB128 varint codec used by the y-websocket sync protocol framing in
 * `use-collab.ts`. Extracted into its own module so it can be unit-tested
 * directly (#16) and reused without pulling in the React hook.
 */

export function encodeVarUint(n: number): Uint8Array {
  const buf: number[] = [];
  let v = n;
  while (v > 0x7f) {
    buf.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  buf.push(v);
  return new Uint8Array(buf);
}

/** Returns [value, nextOffset]. */
export function readVarUint(buf: Uint8Array, offset: number): [number, number] {
  let num = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos]!;
    pos++;
    num |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [num, pos];
}
