/**
 * BLAKE2b, in plain JavaScript, because Argon2id is built out of it and no
 * runtime this console reaches ships one.
 *
 * `crypto.subtle` has SHA-2 and PBKDF2 and nothing else; Hermes has neither.
 * So the hash under the KDF is ours, and being ours it is held to the only
 * standard that means anything for a primitive: it reproduces RFC 7693's own
 * vectors, and `__tests__/argon2id.test.ts` runs them.
 *
 * 64-bit arithmetic is done as pairs of 32-bit words — `lo` at an even index,
 * `hi` at the odd one after it — rather than through `BigInt`, which is roughly
 * an order of magnitude slower per operation and would make the benchmark in
 * `docs/decisions/encryption.md` measure the wrong thing.
 *
 * Keyed hashing, salt and personalisation are deliberately absent. Argon2id
 * uses none of them, and an unused branch through a primitive is a place for a
 * defect to sit where no test looks.
 */

const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

// prettier-ignore
const SIGMA = new Uint8Array([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
  7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
  9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
  2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
  12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
  13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
  6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
  10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
]);

/** Working vector and message schedule, reused across every compression. */
const v = new Uint32Array(32);
const m = new Uint32Array(32);

/** `v[a] += v[b]`, 64-bit. */
function add(a: number, b: number): void {
  const lo = v[a] + v[b];
  v[a + 1] = v[a + 1] + v[b + 1] + (lo >= 0x100000000 ? 1 : 0);
  v[a] = lo;
}

/** `v[a] += m[x]`, 64-bit, where `x` is an even index into the schedule. */
function addMessage(a: number, x: number): void {
  const lo = v[a] + m[x];
  v[a + 1] = v[a + 1] + m[x + 1] + (lo >= 0x100000000 ? 1 : 0);
  v[a] = lo;
}

function g(a: number, b: number, c: number, d: number, x: number, y: number): void {
  add(a, b);
  addMessage(a, x);
  let lo = v[d] ^ v[a];
  let hi = v[d + 1] ^ v[a + 1];
  v[d] = hi;
  v[d + 1] = lo; // rotr 32

  add(c, d);
  lo = v[b] ^ v[c];
  hi = v[b + 1] ^ v[c + 1];
  v[b] = (lo >>> 24) ^ (hi << 8);
  v[b + 1] = (hi >>> 24) ^ (lo << 8); // rotr 24

  add(a, b);
  addMessage(a, y);
  lo = v[d] ^ v[a];
  hi = v[d + 1] ^ v[a + 1];
  v[d] = (lo >>> 16) ^ (hi << 16);
  v[d + 1] = (hi >>> 16) ^ (lo << 16); // rotr 16

  add(c, d);
  lo = v[b] ^ v[c];
  hi = v[b + 1] ^ v[c + 1];
  v[b] = (hi >>> 31) ^ (lo << 1);
  v[b + 1] = (lo >>> 31) ^ (hi << 1); // rotr 63
}

interface Blake2bState {
  h: Uint32Array;
  buffer: Uint8Array;
  filled: number;
  counter: number;
  outLength: number;
}

function compress(state: Blake2bState, last: boolean): void {
  for (let i = 0; i < 16; i += 1) v[i] = state.h[i];
  for (let i = 0; i < 16; i += 1) v[i + 16] = IV[i];
  v[24] = v[24] ^ state.counter;
  v[25] = v[25] ^ Math.floor(state.counter / 0x100000000);
  if (last) {
    v[28] = ~v[28];
    v[29] = ~v[29];
  }
  const b = state.buffer;
  for (let i = 0; i < 32; i += 1) {
    const o = i * 4;
    m[i] = b[o] ^ (b[o + 1] << 8) ^ (b[o + 2] << 16) ^ (b[o + 3] << 24);
  }
  for (let round = 0; round < 12; round += 1) {
    const s = round * 16;
    g(0, 8, 16, 24, SIGMA[s] * 2, SIGMA[s + 1] * 2);
    g(2, 10, 18, 26, SIGMA[s + 2] * 2, SIGMA[s + 3] * 2);
    g(4, 12, 20, 28, SIGMA[s + 4] * 2, SIGMA[s + 5] * 2);
    g(6, 14, 22, 30, SIGMA[s + 6] * 2, SIGMA[s + 7] * 2);
    g(0, 10, 20, 30, SIGMA[s + 8] * 2, SIGMA[s + 9] * 2);
    g(2, 12, 22, 24, SIGMA[s + 10] * 2, SIGMA[s + 11] * 2);
    g(4, 14, 16, 26, SIGMA[s + 12] * 2, SIGMA[s + 13] * 2);
    g(6, 8, 18, 28, SIGMA[s + 14] * 2, SIGMA[s + 15] * 2);
  }
  for (let i = 0; i < 16; i += 1) state.h[i] = state.h[i] ^ v[i] ^ v[i + 16];
}

/** A fresh state producing `outLength` bytes (1..64). */
export function blake2bInit(outLength: number): Blake2bState {
  if (!Number.isInteger(outLength) || outLength < 1 || outLength > 64) {
    throw new RangeError("blake2b output length must be 1..64 bytes");
  }
  const h = IV.slice();
  h[0] = h[0] ^ 0x01010000 ^ outLength;
  return { h, buffer: new Uint8Array(128), filled: 0, counter: 0, outLength };
}

export function blake2bUpdate(state: Blake2bState, input: Uint8Array): void {
  for (let i = 0; i < input.length; i += 1) {
    if (state.filled === 128) {
      state.counter += 128;
      compress(state, false);
      state.filled = 0;
    }
    state.buffer[state.filled] = input[i];
    state.filled += 1;
  }
}

export function blake2bFinal(state: Blake2bState): Uint8Array {
  state.counter += state.filled;
  while (state.filled < 128) {
    state.buffer[state.filled] = 0;
    state.filled += 1;
  }
  compress(state, true);
  const out = new Uint8Array(state.outLength);
  for (let i = 0; i < state.outLength; i += 1) {
    out[i] = (state.h[i >> 2] >>> (8 * (i & 3))) & 0xff;
  }
  return out;
}

/** One-shot: BLAKE2b over the concatenation of `inputs`, `outLength` bytes out. */
export function blake2b(outLength: number, ...inputs: Uint8Array[]): Uint8Array {
  const state = blake2bInit(outLength);
  for (const input of inputs) blake2bUpdate(state, input);
  return blake2bFinal(state);
}
