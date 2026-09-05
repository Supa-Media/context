import { describe, expect, it } from "vitest";
import * as entry from "./index";

/**
 * A Workers **entry** module may only export handlers.
 *
 * workerd validates every named export at instantiation and refuses the whole
 * script if one is not a function or an `ExportedHandler`:
 *
 *   Uncaught TypeError: Incorrect type for map entry 'DEFAULT_TARGET_FOLDER':
 *   the provided value is not of type 'function or ExportedHandler'.
 *
 * That is not hypothetical here — it is what `context-email` shipped. Its entry
 * module re-exported two string constants for the tests' convenience, so the
 * Worker **never instantiated** in production and every inbound message was
 * rejected with Cloudflare's generic "worker script threw an exception", before
 * any handler ran, with no log and no stack. It cost hours.
 *
 * Nothing catches it anywhere else, because every other test imports this
 * module into **node**, where a string export is ordinary and correct. Only
 * workerd objects. This is the cheap stand-in for that check, in the runtime
 * the rest of the suite already uses — and it is why `MAX_AUDIO_BYTES`,
 * `TURBO_MODEL` and the rest live in ./transcribe.ts.
 */
describe("the entry module exports only what workerd accepts", () => {
  it("has a default export that is an ExportedHandler", () => {
    expect(typeof entry.default).toBe("object");
    expect(typeof entry.default.fetch).toBe("function");
  });

  it("exports nothing that is not a function", () => {
    // Types and interfaces are erased before workerd sees the module, so this
    // only sees real runtime values — which is precisely what it must check.
    const offenders = Object.entries(entry)
      .filter(([name]) => name !== "default")
      .filter(([, value]) => typeof value !== "function")
      .map(([name, value]) => `${name}: ${typeof value}`);

    expect(
      offenders,
      "a non-function export here makes the whole Worker fail to instantiate",
    ).toEqual([]);
  });
});
