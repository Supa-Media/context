/**
 * @jest-environment node
 */

/**
 * THE SUBSTITUTED SOURCE OF RANDOMNESS FOR EVERY SHARED DOCUMENT ON A PHONE.
 *
 * `lib0/webcrypto` does not build for a device, so `metro.config.js` swaps in
 * `shims/lib0-webcrypto.js` for `ios` and `android`. Everything Yjs calls
 * random comes through it: `lib0/random`'s `uint32()` is
 * `getRandomValues(new Uint32Array(1))[0]`, and that is the client id and the
 * `versionNonce` on every element of every shared drawing.
 *
 * **The check that shipped with the shim asks whether the native bundle
 * builds.** That was the missing question and it is not this one. A shim that
 * allocated its own array instead of filling the caller's would build
 * perfectly, and `uint32()` would read index 0 of an untouched array and
 * answer **0** for ever — every phone in a room sharing one client id. So what
 * is pinned here is the contract, not the resolution.
 *
 * ## What this can and cannot reach
 *
 * `expo-crypto` is **not transformed by this suite** — `transformIgnorePatterns`
 * allows `expo(@|/)`, which is the `expo` package and not `expo-crypto`, so
 * importing it here fails with "Cannot use import statement outside a module".
 * Measured, not assumed.
 *
 * So the delegate is stubbed with the contract the real one keeps (fill in
 * place, return the same array) and what is checked is **the shim's own
 * three lines**, which is the part this repository owns. Whether a native
 * binding fills a `Uint32Array` on a device is the platform's business and
 * cannot be answered from here by any means — the same "a phone is a third
 * runtime" lesson the OTA outage taught, one layer along.
 */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";

// `mock`-prefixed so the factory below may close over it: jest hoists
// `jest.mock` above the file's own bindings and refuses any other name.
const mockFill = jest.fn((array: ArrayBufferView) => {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + 11) % 256;
  return array;
});

jest.mock("expo-crypto", () => ({ getRandomValues: mockFill }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getRandomValues, subtle } = require("../shims/lib0-webcrypto") as {
  getRandomValues: (array: Uint32Array | Uint8Array) => Uint32Array | Uint8Array;
  subtle: Record<string, () => unknown>;
};

describe("the native lib0/webcrypto shim", () => {
  beforeEach(() => {
    mockFill.mockClear();
  });

  test("hands the caller's own array to the platform, not a copy of it", () => {
    /*
      The failure this exists for. `lib0/random` reads the value back off the
      array it passed in, so a shim that filled a fresh one would answer 0 on
      every call while every other check here still passed.
    */
    const asked = new Uint32Array(4);
    getRandomValues(asked);
    expect(mockFill).toHaveBeenCalledTimes(1);
    expect(mockFill.mock.calls[0]?.[0]).toBe(asked);
  });

  test("...and returns that same array, because lib0 indexes the return value", () => {
    // `uint32()` is `getRandomValues(new Uint32Array(1))[0]` — it never sees
    // the array it passed in again, so dropping the return is a silent zero.
    const asked = new Uint32Array(1);
    expect(getRandomValues(asked)).toBe(asked);
    expect(asked[0]).not.toBe(0);
  });

  test("passes a Uint8Array through untouched too, which is what uuidv4 walks", () => {
    const bytes = new Uint8Array(16);
    expect(getRandomValues(bytes)).toBe(bytes);
    expect(mockFill.mock.calls[0]?.[0]).toBe(bytes);
  });

  test("subtle is absent loudly, naming itself and the file to fix", () => {
    /*
      A throwing stub rather than `undefined` is the shim's own decision and
      the whole value of it is the message: what it replaces is `cannot read
      property 'importKey' of undefined`, inside a dependency, on a device.
    */
    expect(() => subtle.importKey?.()).toThrow(
      /subtle\.importKey is not available in the native bundle/,
    );
    expect(() => subtle.digest?.()).toThrow(/shims\/lib0-webcrypto\.js/);
  });
});
