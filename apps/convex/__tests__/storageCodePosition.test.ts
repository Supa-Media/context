/// <reference types="vite/client" />
/**
 * THE PREMISE THE CONSOLE'S OFFLINE FALLBACK RESTS ON.
 *
 * `apps/mobile/features/console/files/browser.ts` decides, per failed read,
 * whether the copy on the device may be shown instead. A **refusal** — a
 * membership removed, a grant revoked, a note gone private under a `team`
 * viewer — must never be overridden by a cached copy, because that is note
 * content on the screen of somebody the control plane has just refused. A
 * **transport** failure is the opposite case and is the whole reason the
 * fallback exists.
 *
 * Two server answers sit between the two, and `OVERRIDABLE_STORAGE_CODES` in
 * that file names them: `STORAGE_NOT_CONNECTED` and `STORAGE_UNUSABLE`. The
 * argument for letting a cached note through under either is **entirely about
 * where they are raised**. `runFileOperation` throws them before it calls
 * `executeOperation` — before a path is resolved, a note is read, or the
 * privacy engine is asked anything — and its callers have each already
 * established membership and a sufficient role. So by the time one reaches a
 * client, authorization has passed and no per-note question was ever put. The
 * bucket was unreachable; nothing was refused.
 *
 * That argument is a fact about *this file*, asserted in *another app*, and
 * nothing connected the two. Throw `STORAGE_NOT_CONNECTED` from inside a
 * per-note code path next year — a helper in `lib/fileOps.ts`, a second
 * `catch` further down `runFileOperation` — and the console's allow-list
 * silently becomes a way to serve a refused note off the device. No test would
 * have failed. This is that test.
 *
 * ## What it checks
 *
 * It reads the allow-list out of the mobile source rather than restating it,
 * so the two cannot drift, and then, for each code on it, over **every**
 * control-plane module:
 *
 *  1. every occurrence of the literal is inside `runFileOperation`'s handler
 *     body, and
 *  2. every one of them is before the single `executeOperation(` call in it,
 *     which is the only call to that function in the control plane.
 *
 * Rule 1 is the one that does the work: a helper raising the code, a second
 * throw site in another module, a copy of the constant somewhere convenient —
 * all land outside the region and fail, wherever they are and whatever they
 * are called. Rule 2 catches the narrower move of adding a throw to the
 * barrier's own tail.
 *
 * ## What it does NOT catch — plainly, because a guard oversold is worse than
 * none
 *
 *  - **A computed string.** It matches literals. `code: "STORAGE_" + suffix`,
 *    a template literal, or a constant imported from another package is
 *    invisible to it — though the last of those trips the "every listed code
 *    is found at least once" assertion below, which fails loudly rather than
 *    quietly.
 *  - **Textual position is not execution order.** A helper *declared* inside
 *    the region and *called* from within `executeOperation` would satisfy both
 *    rules. Rule 1 keeps that to a helper physically inside one 60-line
 *    handler, where a reviewer of that diff would be looking straight at it,
 *    which is the bound rather than a proof.
 *  - **A code raised before `executeOperation` but after something else that
 *    matters.** It pins position relative to one call, not to authorization —
 *    membership is established by the *public* callers, which this does not
 *    read. `__tests__/files.test.ts` and `roles.test.ts` are where that lives.
 *  - **What the console then does with the code.** That is behaviour, and it
 *    is pinned in `apps/mobile/__tests__/cachedAfterRefusal.test.ts`. This
 *    file only holds up the premise underneath it.
 *
 * The last three tests are the self-test: the same checker is fed sources that
 * break the rule in each of the three ways above that it *does* claim to
 * catch, and must catch all three. A checker nobody has sabotaged is not a
 * checker — CLAUDE.md, "a guard nobody has checked is not a guard".
 */

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Every control-plane module as raw source. The same glob and the same
 * exclusions `structure.test.ts` uses, so a new file cannot escape the scan by
 * being new.
 */
const RAW_SOURCES = import.meta.glob(
  ["../**/*.ts", "!../__tests__/**", "!../node_modules/**", "!../*.config.ts", "!../*.setup.ts"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/** `../functions/files.ts` → `functions/files.ts`, for readable failures. */
function shortPath(globKey: string): string {
  return globKey.replace(/^\.\.\//, "");
}

/**
 * Comments blanked out, **offsets preserved**.
 *
 * Prose is allowed to name these codes — the doc comment on
 * `OVERRIDABLE_STORAGE_CODES` names both, and the one in `files.ts` should be
 * free to explain what it throws and why. What must not exist is a *use*. The
 * same distinction `lookupUsesOf` in `structure.test.ts` draws, and the
 * padding is what lets the position checks below still be about the real file.
 */
function blankComments(source: string): string {
  const pad = (match: string) => match.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, pad)
    .replace(/\/\/[^\n]*/g, pad);
}

/** Every index at which `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found.push(at);
  }
  return found;
}

const MOBILE_BROWSER = "../../mobile/features/console/files/browser.ts";

/**
 * The allow-list, read out of the console rather than restated here.
 *
 * Restating it is the version of this test that passes forever while the two
 * files disagree — which is the failure mode CLAUDE.md describes for the two
 * copies of the preview rule: they are held by running both against the same
 * shapes, never by a comment saying they agree.
 *
 * Throws rather than returning `[]` when the declaration cannot be found. A
 * reformat of that file must break this loudly; an empty list would make every
 * assertion below vacuously true, which is exactly how a guard stops guarding
 * without anybody noticing.
 */
function parseOverridableCodes(source: string): string[] {
  const declaration = /const OVERRIDABLE_STORAGE_CODES\s*=\s*new Set(?:<[^>]*>)?\(\[([^\]]*)\]\)/
    .exec(source);
  if (declaration === null) {
    throw new Error(
      `OVERRIDABLE_STORAGE_CODES could not be read out of ${MOBILE_BROWSER}. ` +
        "If it moved or was renamed, this test has to follow it — the codes it " +
        "names are only safe to override because of what this file asserts.",
    );
  }
  return [...declaration[1]!.matchAll(/["']([A-Z0-9_]+)["']/g)].map((m) => m[1]!);
}

function overridableCodes(): string[] {
  return parseOverridableCodes(
    readFileSync(new URL(MOBILE_BROWSER, import.meta.url), "utf8"),
  );
}

/** Where in `files.ts` the barrier's handler body starts and ends. */
interface Region {
  /** Index of the first character of `export const runFileOperation`. */
  start: number;
  /** Index just past the `});` that closes it. */
  end: number;
  /** Index of the `executeOperation(` call inside it. */
  call: number;
}

/**
 * Locate `runFileOperation`'s body and the one call it makes into the
 * per-note code.
 *
 * The end is the first `});` at column zero after the start — the close of the
 * `internalAction({…})`. Deliberately brittle to a reformat: a region this
 * cannot find is reported as a failure rather than assumed empty, because an
 * empty region silently passes every check that follows it.
 */
function locateRegion(source: string): Region | { problem: string } {
  const start = source.indexOf("export const runFileOperation");
  if (start === -1) return { problem: "runFileOperation is not declared here" };

  const closer = /^\}\);$/m.exec(source.slice(start));
  if (closer === undefined || closer === null) {
    return { problem: "runFileOperation's declaration is never closed at column zero" };
  }
  const end = start + closer.index + closer[0].length;

  const calls = occurrences(source.slice(start, end), "executeOperation(");
  if (calls.length !== 1) {
    return {
      problem: `runFileOperation makes ${calls.length} calls to executeOperation, expected exactly 1`,
    };
  }
  return { start, end, call: start + calls[0]! };
}

/**
 * Every place one of `codes` is used that would break the premise.
 *
 * Takes its sources as an argument so the self-tests below can drive it with
 * a module that breaks the rule, rather than trusting a green run over a
 * codebase that currently obeys it.
 */
function violations(
  sources: Record<string, string>,
  codes: readonly string[],
): string[] {
  const problems: string[] = [];
  const barrierPath = Object.keys(sources).find((key) =>
    blankComments(sources[key]!).includes("export const runFileOperation"),
  );
  if (barrierPath === undefined) {
    return ["nothing in these sources declares runFileOperation"];
  }
  const barrierSource = blankComments(sources[barrierPath]!);
  const region = locateRegion(barrierSource);
  if ("problem" in region) return [`${shortPath(barrierPath)}: ${region.problem}`];

  for (const code of codes) {
    let seen = 0;
    for (const [key, raw] of Object.entries(sources)) {
      const source = blankComments(raw);
      for (const at of occurrences(source, code)) {
        seen += 1;
        if (key !== barrierPath) {
          problems.push(
            `${shortPath(key)} uses ${code}; only runFileOperation may raise it, ` +
              "because the console overrides it with a cached copy",
          );
          continue;
        }
        if (at < region.start || at >= region.end) {
          problems.push(
            `${shortPath(key)} uses ${code} outside runFileOperation's body`,
          );
          continue;
        }
        if (at > region.call) {
          problems.push(
            `${shortPath(key)} uses ${code} after the executeOperation call, ` +
              "so it can no longer promise that no note was reached",
          );
        }
      }
    }
    if (seen === 0) {
      problems.push(
        `${code} is on the console's allow-list and is raised nowhere in the ` +
          "control plane — a renamed or deleted code leaves that entry describing " +
          "a server that no longer exists",
      );
    }
  }
  return problems;
}

function realSources(): Record<string, string> {
  return RAW_SOURCES;
}

/* -------------------------------------------------------------------------- */

describe("the codes the console may override are raised before any note is reached", () => {
  test("the allow-list is readable, and is not empty", () => {
    // Non-vacuity for everything below: an unreadable or empty list would make
    // every other assertion here true about nothing.
    const codes = overridableCodes();
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  test("the parser reads the list rather than knowing it", () => {
    // Sabotage-proofing for the reader itself, through the same function the
    // test above uses: fed a different declaration it must answer differently,
    // or it is a hardcoded pair wearing a regex. And fed a file that does not
    // declare the list at all it must throw, because the alternative — an
    // empty list — is a green run over a check that examined nothing.
    expect(
      parseOverridableCodes(`const OVERRIDABLE_STORAGE_CODES = new Set(["ONE", "TWO"]);`),
    ).toEqual(["ONE", "TWO"]);
    expect(() => parseOverridableCodes("export const somethingElse = 1;")).toThrow(
      /could not be read/,
    );
  });

  test("the barrier is where this test thinks it is", () => {
    // The region has to be found before anything can be said about positions
    // inside it. Asserted separately so a reformat of `files.ts` reads as
    // "this test needs updating" rather than as a security failure.
    const source = blankComments(RAW_SOURCES["../functions/files.ts"]!);
    const region = locateRegion(source);
    expect(region).not.toHaveProperty("problem");
    const found = region as Region;
    const body = source.slice(found.start, found.end);
    expect(body).toContain("getBindingForGateway");
    expect(body).toContain("executeOperation(");
  });

  test("every overridable code is raised inside the barrier, before the operation runs", () => {
    expect(violations(realSources(), overridableCodes())).toEqual([]);
  });

  /* ---------------------------- the self-tests ---------------------------- */

  test("catches a throw added to the barrier after executeOperation runs", () => {
    const found = violations(
      {
        "../functions/files.ts": `
export const runFileOperation = internalAction({
  handler: async (ctx, args) => {
    if (credential === null) {
      throw new ConvexError({ code: "STORAGE_NOT_CONNECTED", message: "no bucket" });
    }
    const result = await executeOperation(store, args.scope, args.operation);
    if (result === undefined) {
      throw new ConvexError({ code: "STORAGE_NOT_CONNECTED", message: "no bucket" });
    }
    return result;
  },
});
`,
      },
      ["STORAGE_NOT_CONNECTED"],
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("after the executeOperation call");
  });

  test("catches a helper in another module raising the code", () => {
    // The move this test exists for: `lib/fileOps.ts` is *inside*
    // `executeOperation`, so a `FileOpError("STORAGE_NOT_CONNECTED")` there is
    // an answer about a note wearing the code that means "we never looked".
    const found = violations(
      {
        "../functions/files.ts": `
export const runFileOperation = internalAction({
  handler: async (ctx, args) => {
    throw new ConvexError({ code: "STORAGE_NOT_CONNECTED", message: "no bucket" });
    return await executeOperation(store, args.scope, args.operation);
  },
});
`,
        "../functions/lib/fileOps.ts": `
export async function readFile(store, args) {
  if (store === null) throw new FileOpError("STORAGE_NOT_CONNECTED", "no bucket");
}
`,
      },
      ["STORAGE_NOT_CONNECTED"],
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("lib/fileOps.ts");
  });

  test("catches a code on the allow-list that the server no longer raises", () => {
    // A rename on the server leaves the console overriding a code nothing
    // sends, and — worse — no longer overriding the one it does. Absence has
    // to be a failure, or this whole test passes best when it is checking
    // least.
    const found = violations(
      {
        "../functions/files.ts": `
export const runFileOperation = internalAction({
  handler: async (ctx, args) => {
    throw new ConvexError({ code: "STORAGE_NOT_CONNECTED", message: "no bucket" });
    return await executeOperation(store, args.scope, args.operation);
  },
});
`,
      },
      ["STORAGE_NOT_CONNECTED", "STORAGE_RENAMED_AWAY"],
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("raised nowhere in the control plane");
  });

  test("prose naming a code is not a use", () => {
    // The comment on `OVERRIDABLE_STORAGE_CODES` names both codes, and the one
    // on `runFileOperation` should be free to as well. A checker that counted
    // those would be deleted by the first person it inconvenienced.
    const found = violations(
      {
        "../functions/files.ts": `
export const runFileOperation = internalAction({
  handler: async (ctx, args) => {
    throw new ConvexError({ code: "STORAGE_NOT_CONNECTED", message: "no bucket" });
    // Never STORAGE_NOT_CONNECTED past this line.
    return await executeOperation(store, args.scope, args.operation);
  },
});
/** Raising STORAGE_NOT_CONNECTED from in here would be a disclosure. */
export async function executeOperation() {}
`,
      },
      ["STORAGE_NOT_CONNECTED"],
    );
    expect(found).toEqual([]);
  });
});
