/**
 * Every namespace this app writes to the device is either cleared on sign-out
 * or deliberately kept, and the choice is made here rather than by omission.
 *
 * `forget.ts` clears four namespaces **by name** — the offline copies, the
 * last place, the meetings record and the setup guide's progress — because
 * `ownedKeys` only reaches the first. It then verifies with the same four
 * predicates it deleted with. That shape has already failed once: the setup
 * guide's record held the paths of notes an agent wrote, sign-out did not take
 * it, and the verification counted zero and reported `cleared` over it. **A
 * check built from the same enumeration as the action cannot catch an omission
 * in that enumeration.**
 *
 * So this test does not restate the list. It *discovers* the namespaces from
 * the source and holds each one to an answer:
 *
 *  - **cleared** — seed a key under it, run the real `forgetLocalCopies()`, and
 *    the key is gone *and* the verdict is still `cleared`. Both halves, because
 *    a delete without the verification is the failure above in reverse.
 *  - **kept** — it is in `KEPT` below, with a reason somebody wrote down.
 *
 * A new namespace is in neither, so it fails until somebody decides. And a
 * `KEPT` entry whose namespace has left the source fails too, so the list
 * cannot quietly outlive what it excuses.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { KeyValueStore } from "../features/offline/memory";

let mockOpened: KeyValueStore;

jest.mock("../features/offline/store", () => ({
  openStore: () => mockOpened,
}));

const { forgetLocalCopies } =
  require("../features/offline/forget") as typeof import("../features/offline/forget");

function store(
  seed: Record<string, string>,
  options: { removes?: boolean } = {},
): KeyValueStore {
  const held = new Map<string, string>(Object.entries(seed));
  return {
    durable: true,
    get: async (key) => held.get(key) ?? null,
    set: async (key, value) => {
      held.set(key, value);
    },
    // A store that accepts a removal and performs none is the one the verdict
    // exists for, and the only way to ask which namespaces the count covers.
    remove: async (key) => {
      if (options.removes !== false) held.delete(key);
    },
    keys: async () => [...held.keys()],
  };
}

/** Both separator conventions in use, since each namespace picks its own. */
function probeKeys(namespace: string): string[] {
  return [
    `context.lc.${namespace}.v1.probe-key-for-this-test`,
    `context.lc.${namespace}\u001fv1\u001fprobe-key-for-this-test`,
  ];
}

/**
 * Namespaces that survive a sign-out on purpose.
 *
 * The bar each one clears: it holds **no note text and no note name**. A path
 * is the name of one of somebody's notes, which is the argument `lastPlace`,
 * the meetings destination and the setup guide's `written` list each lost.
 *
 * What these do carry, stated rather than implied: three of them put a
 * `workspaceId` in the key, so the set of keys on a device says which contexts
 * have been opened on it. That is visible only to somebody who can already read
 * the origin's storage on that machine, and it is a context id rather than
 * anything in the context — but it is the reason these are argued one at a
 * time instead of waved through as "just flags".
 */
const KEPT: Record<string, string> = {
  probe: "One byte written and removed in the same call, to find out whether this browser allows site data at all (`store.web.ts`). Never present between calls.",
  "mirror-probe": "The same, for IndexedDB (`mirrorStore.web.ts`) — and not in the key-value store this clear walks.",
  onboarding: "`resume-asked.v1`, one boolean with no workspace and no path: whether the resume prompt has been offered on this device. Keeping it means the next person is not asked; clearing it would be defensible and is not a disclosure either way.",
  "context-intro": "`dismissed.v1.<kind>.<workspaceId>`, the value `\"1\"`: this context's intro has been read here. A dismissal that carries across a sign-out is a UX choice, not a leak.",
  "setup-widget": "`retired.v1.<workspaceId>`, whether the widget has been put away on this device. Its own file notes the widget's states are never stored — each is re-derived from a fact every time — so this flag is all there is.",
  "storage-migration": "`dismissed.v1.<workspaceId>`, whether the migration notice has been waved off here. Whether the migration is *needed* is re-read from the binding every time; this only stops the offer.",
};

/** Every `context.lc.<namespace>` this app's source writes, wherever it writes it. */
function namespacesInSource(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx|js)$/.test(entry)) continue;
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(/context\.lc\.([A-Za-z0-9-]+)/g)) {
        const namespace = match[1]!;
        const where = found.get(namespace);
        if (where === undefined) found.set(namespace, [path]);
        else if (!where.includes(path)) where.push(path);
      }
    }
  };
  walk(join(__dirname, "..", "features"));
  walk(join(__dirname, "..", "app"));
  return found;
}

/** `warnLeftBehind` is the expected output of the count test, not a surprise. */
let warn: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("what this app leaves on the device", () => {
  test("every namespace in the source is either cleared on sign-out or kept on purpose", async () => {
    const found = namespacesInSource();
    // Anti-vacuity: a scan that found nothing would pass everything below.
    expect(found.has("offline")).toBe(true);
    expect(found.size).toBeGreaterThanOrEqual(8);

    const unexplained: string[] = [];
    for (const [namespace, files] of found) {
      if (namespace in KEPT) continue;
      /*
        Each namespace picks its own separator — `\u001f` for the offline
        copies and the meetings record, `.` for the last place and the setup
        guide — so both are offered and one has to be swept. This asks "is
        this namespace cleared at all", which is the omission that has
        actually happened; it does not ask whether a clear would survive its
        own namespace changing separator, which is a different question and
        one for the module that owns each key.
      */
      const keys = probeKeys(namespace);
      mockOpened = store(Object.fromEntries(keys.map((key) => [key, "seeded"])));
      const verdict = await forgetLocalCopies();
      const left = (
        await Promise.all(keys.map((key) => mockOpened.get(key)))
      ).filter((value) => value !== null);
      if (left.length === keys.length || verdict.verdict !== "cleared") {
        unexplained.push(`${namespace} (${files.join(", ")}) — ${verdict.verdict}`);
      }
    }

    /*
      The message is the point of the failure. Somebody adding a namespace
      should read what their two options are, not a boolean.
    */
    expect(unexplained).toEqual([]);
  }, 30_000);

  test("and nothing is excused that the source no longer writes", () => {
    const found = namespacesInSource();
    expect(Object.keys(KEPT).filter((namespace) => !found.has(namespace))).toEqual([]);
  });

  test("and the verdict counts each one, so a store that only pretends is caught", async () => {
    /*
      The half that actually went wrong. The delete and the count are built from
      the same list of predicates, so a namespace missing from it is invisible
      twice over: nothing removes the record, and the verification reports
      `cleared` across it. Deleting is therefore not enough to prove here —
      against a store that accepts every removal and performs none, each
      cleared namespace has to make the verdict say so.
    */
    const uncounted: string[] = [];
    for (const [namespace, files] of namespacesInSource()) {
      if (namespace in KEPT) continue;
      const keys = probeKeys(namespace);
      mockOpened = store(
        Object.fromEntries(keys.map((key) => [key, "seeded"])),
        { removes: false },
      );
      const verdict = await forgetLocalCopies();
      if (verdict.verdict !== "left-behind") {
        uncounted.push(`${namespace} (${files.join(", ")}) — ${verdict.verdict}`);
      }
    }
    expect(uncounted).toEqual([]);
  }, 30_000);

  test("a namespace nobody has decided about fails, rather than passing quietly", async () => {
    // The witness. Without it, "every namespace is accounted for" would also
    // be true of a test that accounted for none of them.
    const key = "context.lc.a-namespace-nobody-cleared.v1.w1";
    mockOpened = store({ [key]: "seeded" });

    const verdict = await forgetLocalCopies();

    expect(verdict).toEqual({ verdict: "cleared" });
    expect(await mockOpened.get(key)).toBe("seeded");
  });
});
