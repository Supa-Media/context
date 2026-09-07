/**
 * Argon2id (RFC 9106), in plain JavaScript.
 *
 * ## Why this file exists at all
 *
 * The passphrase that opens an encrypted note is turned into a key **on the
 * device and nowhere else** — that is the whole of Phase 2, and it means the
 * KDF has to run in whatever the console happens to be running in. Web Crypto
 * offers PBKDF2 and no memory-hard KDF, so a real Argon2id is either a WebAssembly
 * dependency or this. `docs/decisions/encryption.md`, "The KDF, per client",
 * measures both and says why this is the one that ships: it is the only answer
 * that survives an over-the-air update, works identically in the browser, in
 * the Electron shell and in a test, and adds nothing to `package.json` that
 * somebody has to trust.
 *
 * ## What it is held to
 *
 * RFC 9106's own test vector, in `__tests__/argon2id.test.ts`, including the
 * secret and associated-data inputs this console never uses — a KDF that agrees
 * with the reference implementation on four inputs and not on six is a KDF that
 * has a bug in one of the six, and the vector is the only way to know.
 *
 * The `secret` and `associatedData` parameters therefore exist for that vector
 * and are not part of the recipient format. A passphrase recipient carries
 * `m`, `t`, `p` and a salt, and nothing else can vary; anything more would be
 * one more thing a third-party decryptor has to reproduce exactly to open
 * somebody's note.
 *
 * ## Shape
 *
 * A block is 1024 bytes = 128 64-bit words, and 64-bit words are held as two
 * 32-bit words — `lo` at an even index, `hi` at the odd one after it — inside
 * one flat `Uint32Array` for the whole memory. That is what makes a 64 MiB
 * parameter set one allocation rather than 65,536 of them, and it is why this
 * implementation is worth benchmarking rather than assuming.
 */

import { blake2b } from "./blake2b.ts";

/** 1024 bytes, as 32-bit words. */
const WORDS_PER_BLOCK = 256;
/** Argon2's four synchronisation points per pass. */
const SLICES = 4;
/** 64-bit addresses in one address block. */
const ADDRESSES_PER_BLOCK = 128;
/** Argon2id. `0` is Argon2d and `1` is Argon2i; neither is written here. */
const TYPE_ARGON2ID = 2;
/** The version this implements. A different one is a different KDF. */
export const ARGON2_VERSION = 0x13;

export interface Argon2idInput {
  password: Uint8Array;
  salt: Uint8Array;
  /** KiB of memory. */
  memory: number;
  /** Passes. */
  iterations: number;
  /** Lanes. */
  parallelism: number;
  /** Output bytes. */
  tagLength: number;
  /** RFC 9106's optional keyed input. Unused by this product; here for the vector. */
  secret?: Uint8Array;
  /** RFC 9106's optional associated data. Unused by this product; here for the vector. */
  associatedData?: Uint8Array;
}

function le32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = value & 0xff;
  out[1] = (value >>> 8) & 0xff;
  out[2] = (value >>> 16) & 0xff;
  out[3] = (value >>> 24) & 0xff;
  return out;
}

/**
 * RFC 9106's variable-length hash `H'`.
 *
 * Up to 64 bytes it is BLAKE2b with the length prefixed. Beyond that it is a
 * chain of 64-byte hashes whose first 32 bytes each are kept — which is how a
 * 1024-byte block gets produced by a 64-byte hash.
 */
function hashPrime(outLength: number, ...inputs: Uint8Array[]): Uint8Array {
  if (outLength <= 64) return blake2b(outLength, le32(outLength), ...inputs);
  const out = new Uint8Array(outLength);
  let previous = blake2b(64, le32(outLength), ...inputs);
  out.set(previous.subarray(0, 32), 0);
  const rounds = Math.ceil(outLength / 32) - 2;
  for (let i = 1; i < rounds; i += 1) {
    previous = blake2b(64, previous);
    out.set(previous.subarray(0, 32), i * 32);
  }
  out.set(blake2b(outLength - 32 * rounds, previous), rounds * 32);
  return out;
}

/* ------------------------------ the round -------------------------------- */
//
// The 16-word permutation Argon2 borrows from BLAKE2b, with BLAKE2b's `G`
// replaced by one that folds in `2 * lo32(a) * lo32(b)`. That multiply is the
// reason this cannot simply call the hash above, and it is most of the cost.

/** One 16-word (32-slot) permutation working area. */
const p = new Uint32Array(32);

/** `p[a] = p[a] + p[b] + 2 * lo32(p[a]) * lo32(p[b])`, 64-bit, exact. */
function fma(a: number, b: number): void {
  const xl = p[a];
  const xh = p[a + 1];
  const yl = p[b];
  const yh = p[b + 1];

  // 32x32 -> 64 through 16-bit halves, so every intermediate stays under 2^53
  // and the arithmetic is exact in a double. `BigInt` would be exact too, and
  // about ten times slower in the innermost loop of the whole KDF.
  const a0 = xl & 0xffff;
  const a1 = xl >>> 16;
  const b0 = yl & 0xffff;
  const b1 = yl >>> 16;
  const mid = a0 * b1 + a1 * b0;
  let lo = a0 * b0 + (mid % 65536) * 65536;
  let hi = a1 * b1 + Math.floor(mid / 65536) + Math.floor(lo / 4294967296);
  lo = lo % 4294967296;
  // times two
  hi = hi * 2 + (lo >= 2147483648 ? 1 : 0);
  lo = (lo * 2) % 4294967296;

  const sum = xl + yl + lo;
  p[a] = sum;
  p[a + 1] = xh + yh + hi + Math.floor(sum / 4294967296);
}

/** `p[x] = rotr64(p[x] ^ p[y], n)` for the four `n` the round uses. */
function xorRotate(x: number, y: number, n: number): void {
  const lo = p[x] ^ p[y];
  const hi = p[x + 1] ^ p[y + 1];
  if (n === 32) {
    p[x] = hi;
    p[x + 1] = lo;
  } else if (n === 24) {
    p[x] = (lo >>> 24) ^ (hi << 8);
    p[x + 1] = (hi >>> 24) ^ (lo << 8);
  } else if (n === 16) {
    p[x] = (lo >>> 16) ^ (hi << 16);
    p[x + 1] = (hi >>> 16) ^ (lo << 16);
  } else {
    // 63, which is a left rotate by one.
    p[x] = (hi >>> 31) ^ (lo << 1);
    p[x + 1] = (lo >>> 31) ^ (hi << 1);
  }
}

function gb(a: number, b: number, c: number, d: number): void {
  fma(a, b);
  xorRotate(d, a, 32);
  fma(c, d);
  xorRotate(b, c, 24);
  fma(a, b);
  xorRotate(d, a, 16);
  fma(c, d);
  xorRotate(b, c, 63);
}

/** The permutation over `p`'s 16 64-bit words. */
function permute(): void {
  gb(0, 8, 16, 24);
  gb(2, 10, 18, 26);
  gb(4, 12, 20, 28);
  gb(6, 14, 22, 30);
  gb(0, 10, 20, 30);
  gb(2, 12, 22, 24);
  gb(4, 14, 16, 26);
  gb(6, 8, 18, 28);
}

/* ---------------------------- the compression ---------------------------- */

/** `R`, and the copy of it the output is XORed back into. */
const blockR = new Uint32Array(WORDS_PER_BLOCK);
const blockTmp = new Uint32Array(WORDS_PER_BLOCK);

/**
 * `next = G(prev, ref)`, or `next = G(prev, ref) XOR next` on a later pass.
 *
 * Every argument is an array plus a word offset rather than a block, so the
 * whole of memory can be one allocation and the address blocks — which live
 * outside it — go through the same function.
 */
function fillBlock(
  prev: Uint32Array,
  prevAt: number,
  ref: Uint32Array,
  refAt: number,
  next: Uint32Array,
  nextAt: number,
  withXor: boolean,
): void {
  for (let i = 0; i < WORDS_PER_BLOCK; i += 1) blockR[i] = ref[refAt + i] ^ prev[prevAt + i];
  blockTmp.set(blockR);
  if (withXor) {
    for (let i = 0; i < WORDS_PER_BLOCK; i += 1) blockTmp[i] = blockTmp[i] ^ next[nextAt + i];
  }

  // Rows: 16 consecutive 64-bit words at a time.
  for (let i = 0; i < 8; i += 1) {
    const at = i * 32;
    for (let j = 0; j < 32; j += 1) p[j] = blockR[at + j];
    permute();
    for (let j = 0; j < 32; j += 1) blockR[at + j] = p[j];
  }
  // Columns: two adjacent 64-bit words taken from each of the eight rows.
  for (let i = 0; i < 8; i += 1) {
    const at = i * 4;
    for (let k = 0; k < 8; k += 1) {
      const from = at + k * 32;
      p[k * 4] = blockR[from];
      p[k * 4 + 1] = blockR[from + 1];
      p[k * 4 + 2] = blockR[from + 2];
      p[k * 4 + 3] = blockR[from + 3];
    }
    permute();
    for (let k = 0; k < 8; k += 1) {
      const from = at + k * 32;
      blockR[from] = p[k * 4];
      blockR[from + 1] = p[k * 4 + 1];
      blockR[from + 2] = p[k * 4 + 2];
      blockR[from + 3] = p[k * 4 + 3];
    }
  }

  for (let i = 0; i < WORDS_PER_BLOCK; i += 1) next[nextAt + i] = blockTmp[i] ^ blockR[i];
}

/** `floor(a * b / 2^32)` for two 32-bit unsigned values, exactly. */
function mulShift32(a: number, b: number): number {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  const mid = a0 * b1 + a1 * b0;
  const lo = a0 * b0 + (mid % 65536) * 65536;
  return a1 * b1 + Math.floor(mid / 65536) + Math.floor(lo / 4294967296);
}

/* -------------------------------- the KDF -------------------------------- */

/**
 * Derive `tagLength` bytes from a passphrase.
 *
 * Synchronous and single-threaded: `parallelism` lanes are computed in
 * sequence, which produces the same output as any other Argon2 implementation
 * at the same parameters and simply takes longer. A console that wants the main
 * thread back runs this in a worker; the decision file says which one does.
 */
export function argon2id(input: Argon2idInput): Uint8Array {
  const {
    password,
    salt,
    memory,
    iterations,
    parallelism,
    tagLength,
    secret = new Uint8Array(0),
    associatedData = new Uint8Array(0),
  } = input;

  if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 0xffffff) {
    throw new RangeError("argon2id: parallelism must be 1..2^24-1");
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new RangeError("argon2id: iterations must be at least 1");
  }
  if (!Number.isInteger(tagLength) || tagLength < 4) {
    throw new RangeError("argon2id: tag length must be at least 4 bytes");
  }
  if (!Number.isInteger(memory) || memory < 8 * parallelism) {
    throw new RangeError("argon2id: memory must be at least 8 KiB per lane");
  }
  if (salt.length < 8) throw new RangeError("argon2id: salt must be at least 8 bytes");

  const h0 = blake2b(
    64,
    le32(parallelism),
    le32(tagLength),
    le32(memory),
    le32(iterations),
    le32(ARGON2_VERSION),
    le32(TYPE_ARGON2ID),
    le32(password.length),
    password,
    le32(salt.length),
    salt,
    le32(secret.length),
    secret,
    le32(associatedData.length),
    associatedData,
  );

  const segmentLength = Math.floor(memory / (SLICES * parallelism));
  const laneLength = segmentLength * SLICES;
  const blocks = laneLength * parallelism;
  const words = new Uint32Array(blocks * WORDS_PER_BLOCK);

  // The two seed blocks per lane.
  const seed = new Uint8Array(72);
  seed.set(h0, 0);
  for (let lane = 0; lane < parallelism; lane += 1) {
    seed.set(le32(lane), 68);
    for (const index of [0, 1]) {
      seed.set(le32(index), 64);
      const block = hashPrime(1024, seed);
      const at = (lane * laneLength + index) * WORDS_PER_BLOCK;
      for (let i = 0; i < WORDS_PER_BLOCK; i += 1) {
        const o = i * 4;
        words[at + i] =
          block[o] ^ (block[o + 1] << 8) ^ (block[o + 2] << 16) ^ (block[o + 3] << 24);
      }
    }
  }

  const zeroBlock = new Uint32Array(WORDS_PER_BLOCK);
  const inputBlock = new Uint32Array(WORDS_PER_BLOCK);
  const addressBlock = new Uint32Array(WORDS_PER_BLOCK);

  for (let pass = 0; pass < iterations; pass += 1) {
    for (let slice = 0; slice < SLICES; slice += 1) {
      for (let lane = 0; lane < parallelism; lane += 1) {
        // Argon2id: data-independent addressing for the first half of the first
        // pass, data-dependent afterwards. That split is the whole of the "id".
        const independent = pass === 0 && slice < SLICES / 2;
        if (independent) {
          inputBlock.fill(0);
          inputBlock[0] = pass;
          inputBlock[2] = lane;
          inputBlock[4] = slice;
          inputBlock[6] = blocks;
          inputBlock[8] = iterations;
          inputBlock[10] = TYPE_ARGON2ID;
          inputBlock[12] = 0;
        }

        let index = pass === 0 && slice === 0 ? 2 : 0;
        if (independent && index === 2) nextAddresses(inputBlock, addressBlock, zeroBlock);

        for (; index < segmentLength; index += 1) {
          const current = lane * laneLength + slice * segmentLength + index;
          const previous = current % laneLength === 0 ? current + laneLength - 1 : current - 1;

          let j1: number;
          let j2: number;
          if (independent) {
            if (index % ADDRESSES_PER_BLOCK === 0) {
              nextAddresses(inputBlock, addressBlock, zeroBlock);
            }
            j1 = addressBlock[(index % ADDRESSES_PER_BLOCK) * 2];
            j2 = addressBlock[(index % ADDRESSES_PER_BLOCK) * 2 + 1];
          } else {
            j1 = words[previous * WORDS_PER_BLOCK];
            j2 = words[previous * WORDS_PER_BLOCK + 1];
          }

          const refLane = pass === 0 && slice === 0 ? lane : (j2 >>> 0) % parallelism;
          const sameLane = refLane === lane;
          let areaSize: number;
          if (pass === 0) {
            if (slice === 0) areaSize = index - 1;
            else if (sameLane) areaSize = slice * segmentLength + index - 1;
            else areaSize = slice * segmentLength + (index === 0 ? -1 : 0);
          } else if (sameLane) {
            areaSize = laneLength - segmentLength + index - 1;
          } else {
            areaSize = laneLength - segmentLength + (index === 0 ? -1 : 0);
          }

          let relative = mulShift32(j1 >>> 0, j1 >>> 0);
          relative = areaSize - 1 - mulShift32(areaSize, relative);
          const start =
            pass === 0 ? 0 : slice === SLICES - 1 ? 0 : (slice + 1) * segmentLength;
          const reference = refLane * laneLength + ((start + relative) % laneLength);

          fillBlock(
            words,
            previous * WORDS_PER_BLOCK,
            words,
            reference * WORDS_PER_BLOCK,
            words,
            current * WORDS_PER_BLOCK,
            pass !== 0,
          );
        }
      }
    }
  }

  // The last block of every lane, XORed together, hashed to the tag.
  const final = new Uint32Array(WORDS_PER_BLOCK);
  for (let lane = 0; lane < parallelism; lane += 1) {
    const at = (lane * laneLength + laneLength - 1) * WORDS_PER_BLOCK;
    for (let i = 0; i < WORDS_PER_BLOCK; i += 1) final[i] = final[i] ^ words[at + i];
  }
  const finalBytes = new Uint8Array(1024);
  for (let i = 0; i < WORDS_PER_BLOCK; i += 1) {
    const o = i * 4;
    finalBytes[o] = final[i] & 0xff;
    finalBytes[o + 1] = (final[i] >>> 8) & 0xff;
    finalBytes[o + 2] = (final[i] >>> 16) & 0xff;
    finalBytes[o + 3] = (final[i] >>> 24) & 0xff;
  }

  // Nothing here is a secret this process gets to keep: the memory holds the
  // whole derivation, and a lingering copy of it is a lingering copy of the
  // passphrase's strength. Zeroing is best-effort in a garbage-collected
  // runtime and is done anyway, because the alternative is not doing it.
  const tag = hashPrime(tagLength, finalBytes);
  words.fill(0);
  final.fill(0);
  finalBytes.fill(0);
  blockR.fill(0);
  blockTmp.fill(0);
  p.fill(0);
  return tag;
}

/** RFC 9106's `next_addresses`: two compressions over a counter block. */
function nextAddresses(
  inputBlock: Uint32Array,
  addressBlock: Uint32Array,
  zeroBlock: Uint32Array,
): void {
  inputBlock[12] += 1;
  fillBlock(zeroBlock, 0, inputBlock, 0, addressBlock, 0, false);
  fillBlock(zeroBlock, 0, addressBlock, 0, addressBlock, 0, false);
}
