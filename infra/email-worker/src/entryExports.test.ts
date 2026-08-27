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
 * That is exactly what shipped. `index.ts` re-exported two string constants for
 * the tests' convenience, so `context-email` **never instantiated** in
 * production. Every inbound message was rejected with Cloudflare's generic
 * "worker script threw an exception" — before any handler ran, so there was no
 * log, no stack, and no request to the control plane to trace. It cost hours.
 *
 * Nothing caught it because every other test imports this module into **node**,
 * where a string export is ordinary and correct. Only workerd objects. This
 * test is the cheap stand-in for that check: it asserts the shape workerd
 * demands, in the runtime the rest of the suite already uses.
 */
describe("the entry module exports only what workerd accepts", () => {
  it("has a default export that is an ExportedHandler", () => {
    expect(typeof entry.default).toBe("object");
    expect(typeof entry.default.email).toBe("function");
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
