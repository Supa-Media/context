/**
 * Content-Transfer-Encoding decoding: base64 and quoted-printable.
 *
 * Split out of `../mime.ts`; see that file's docblock for the parser's threat
 * model.
 */

import { latin1Encode } from "./bytes";

/** Strict-ish base64 → bytes, or `null` when there is nothing usable. */
export function base64Decode(value: string): Uint8Array | null {
  // Padding is dropped and recomputed rather than trusted: a part may be
  // several base64 chunks concatenated, a forward may have clipped the tail,
  // and `atob` rejects anything whose length is not a multiple of four. A
  // truncated part is common enough that decoding what is there beats
  // discarding the whole body.
  const core = value.replace(/[^A-Za-z0-9+/]/g, "");
  if (!core) return new Uint8Array(0);
  // A remainder of one cannot encode any whole byte, so that character goes.
  const usable = core.length % 4 === 1 ? core.slice(0, -1) : core;
  if (!usable) return new Uint8Array(0);
  const padding = usable.length % 4 === 0 ? "" : "=".repeat(4 - (usable.length % 4));
  try {
    return latin1Encode(atob(usable + padding));
  } catch {
    return null;
  }
}

/**
 * Quoted-printable → bytes.
 *
 * `underscoreIsSpace` is the RFC 2047 Q variant, where `_` stands for a space.
 * A hand-written scan rather than a regex: the soft-line-break rule (`=` at
 * end of line) and the "an invalid escape stays literal" rule are both easier
 * to get right, and to read, as a loop.
 */
export function quotedPrintableDecode(value: string, underscoreIsSpace = false): Uint8Array {
  // Pre-sized, not a `number[]` grown by `push`.
  //
  // Output is never longer than input — every branch consumes at least one
  // character and emits at most one byte — so one allocation of `value.length`
  // is both sufficient and an upper bound. The array-of-numbers version cost
  // roughly 147 MB of heap for a 5 MB body, in a 128 MB isolate that concurrent
  // deliveries share. An OOM there is not the `parse_failed` this module
  // promises: the isolate dies and takes its neighbours with it.
  const out = new Uint8Array(value.length);
  let outLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "_" && underscoreIsSpace) {
      out[outLength++] = 0x20;
      continue;
    }
    if (char !== "=") {
      out[outLength++] = char.charCodeAt(0) & 0xff;
      continue;
    }
    const next = value[index + 1];
    if (next === "\n") {
      index += 1;
      continue;
    }
    if (next === "\r" && value[index + 2] === "\n") {
      index += 2;
      continue;
    }
    const hex = value.slice(index + 1, index + 3);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      out[outLength++] = parseInt(hex, 16);
      index += 2;
      continue;
    }
    // Not a valid escape. RFC 2045 says this is illegal; every real client
    // renders it literally, and so do we.
    out[outLength++] = 0x3d;
  }
  return out.subarray(0, outLength);
}

export function decodeTransfer(body: string, encoding: string): Uint8Array {
  const normalized = encoding.toLowerCase().trim();
  if (normalized === "base64") return base64Decode(body) ?? new Uint8Array(0);
  if (normalized === "quoted-printable") return quotedPrintableDecode(body);
  return latin1Encode(body);
}
