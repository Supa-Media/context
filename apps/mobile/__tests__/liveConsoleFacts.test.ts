/**
 * @jest-environment jsdom
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "@jest/globals";

// React refuses to run `act` without this, and warns on every call otherwise.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { getFunctionName } from "convex/server";
import { api } from "@context/convex/_generated/api";
import { SettingsPane } from "../features/console/panes/SettingsPane";
import type { ConsoleData } from "../features/console/types";
import { useDemoConsoleData } from "../features/console/useDemoConsoleData";
import { useLiveConsoleData } from "../features/console/useLiveConsoleData";

/**
 * Nothing invented may reach a signed-in person as a fact about their bucket.
 *
 * `emptyConsoleStats.test.ts` guards the account with *no* contexts, which is
 * the case #20 fixed. This file guards the one it left behind: an account with
 * a context and a connected bucket, which is every real user, and which was
 * still being shown five constants out of `placeholderData.ts` as verified
 * facts about their own storage —
 *
 *   | shown                             | measured on the live site |
 *   | --------------------------------- | ------------------------- |
 *   | ✓ Reachable — 1,284 objects       | 6 objects                 |
 *   | ✓ PARA structure present          | no PARA scaffold at all   |
 *   | Versioning is off — turn it on    | hardcoded; user had it on |
 *   | 1,284 notes across all            | 3 notes                   |
 *   | 2.4 GB in your own bucket         | ~160 bytes                |
 *
 * — with check marks, beside `Conditional writes verified`, which is genuinely
 * derived from `binding.capabilities.conditionalWrite`. A fake check mark next
 * to a true one makes the true one unbelievable, which is why this is worth a
 * test rather than a careful reviewer.
 *
 * The live hook is mounted against a Convex client that answers with one
 * workspace and one connected binding, and the real `SettingsPane` is rendered
 * from what it returns — so this asserts on the words on the screen, not on an
 * intermediate shape.
 */

/** The exact strings that shipped. If any of these renders, the bug is back. */
const INVENTED = ["1,284", "2.4 GB", "objects", "PARA structure present", "Versioning is"];

const WORKSPACE_ID = "ws_1";

const CONNECTED_BINDING = {
  provider: "Cloudflare R2",
  endpoint: "acct.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "brain",
  maskedAccessKeyId: "a1b2…8f3c",
  capabilities: { conditionalWrite: true },
  status: "connected",
  lastVerifiedAt: 1,
  updatedAt: 1,
};

const QUERY_RESULTS: Record<string, unknown> = {
  [getFunctionName(api.functions.workspaces.listMyWorkspaces)]: [
    {
      workspaceId: WORKSPACE_ID,
      slug: "seyi",
      displayName: "seyi",
      kind: "personal",
      role: "owner",
    },
  ],
  [getFunctionName(api.functions.storage.getStorageBinding)]: CONNECTED_BINDING,
  [getFunctionName(api.functions.grants.listGrants)]: [],
  [getFunctionName(api.functions.workspaces.listMembers)]: [],
  [getFunctionName(api.functions.invitations.listInvitations)]: [],
};

/**
 * The smallest client `useQueries` accepts, answering by function name.
 *
 * `action` returns a promise that never settles on purpose: the file browser
 * fires `listFiles` on mount, and a resolved `undefined` would send it down a
 * path it has no reason to walk here.
 */
function fakeConvexClient() {
  const watchFor = (query: unknown) => {
    const result = QUERY_RESULTS[getFunctionName(query as never)];
    return {
      localQueryResult: () => result,
      onUpdate: () => () => {},
      journal: () => undefined,
    };
  };
  return {
    watchQuery: watchFor,
    watchPaginatedQuery: watchFor,
    mutation: async () => undefined,
    action: () => new Promise(() => {}),
    connectionState: () => ({ isWebSocketConnected: true }),
  } as never;
}

/**
 * The live hook, against a client whose storage query answers with `binding`.
 *
 * `QUERY_RESULTS` is keyed by function name and read at watch time, so swapping
 * the entry for the duration of one render is enough — no second client.
 */
function withBinding(binding: Record<string, unknown>): () => ConsoleData {
  const key = getFunctionName(api.functions.storage.getStorageBinding);
  return () => {
    QUERY_RESULTS[key] = binding;
    try {
      return useLiveConsoleData();
    } finally {
      QUERY_RESULTS[key] = CONNECTED_BINDING;
    }
  };
}

/** Mounts a console hook and renders the real settings pane from its data. */
function renderSettings(useData: () => ConsoleData): { data: ConsoleData; text: string } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let latest: ConsoleData | null = null;

  function Harness() {
    latest = useData();
    return createElement(SettingsPane, { data: latest, onClose: () => {} });
  }

  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(
      createElement(ConvexProvider, { client: fakeConvexClient() }, createElement(Harness)),
    );
  });
  const text = container.textContent ?? "";
  act(() => root.unmount());
  container.remove();
  return { data: latest!, text };
}

describe("the signed-in console states no fact it cannot answer", () => {
  test("a connected bucket is not given an object count, a PARA verdict, or a versioning state", () => {
    const { data } = renderSettings(useLiveConsoleData);

    expect(data.demo).toBe(false);
    expect(data.contexts).toHaveLength(1);
    expect(data.storage?.connected).toBe(true);

    expect(data.storage?.objectCount).toBeUndefined();
    expect(data.storage?.paraPresent).toBeUndefined();
    expect(data.storage?.versioningOn).toBeUndefined();
  });

  test("none of the invented sentences reaches the storage card", () => {
    const { text } = renderSettings(useLiveConsoleData);
    for (const phrase of INVENTED) expect(text).not.toContain(phrase);
  });

  test("the claims that are genuinely derived are untouched", () => {
    // The point of removing the fakes is that what is left can be believed, so
    // the true check mark and the real binding fields have to still be there.
    const { text } = renderSettings(useLiveConsoleData);
    expect(text).toContain("Conditional writes verified");
    expect(text).toContain("Cloudflare R2");
    expect(text).toContain("brain");
    expect(text).toContain("a1b2…8f3c");
    expect(text).toContain("Connected");
  });

  /**
   * The note tile's rule changed, and the invariant did not.
   *
   * "notes across all" is a real number now — something walks the bucket and
   * records what it counted. What still must never happen is a tile drawn from
   * anything other than that walk, and the binding here is the case that proves
   * it: connected, verified, and never counted. #20 guarded
   * `contexts.length === 0` only, so connecting a first bucket brought
   * "1,284 notes across all" straight back; the guard is now "no count, no
   * tile" and it has to hold on a binding that looks healthy in every other
   * way.
   */
  test("a connected bucket nobody has counted still gets no note tile", () => {
    const { data } = renderSettings(useLiveConsoleData);
    const labels = data.stats.map((stat) => stat.label);

    expect(labels).not.toContain("notes across all");
    // Bytes are still unmeasured by anything, so that tile stays gone outright.
    expect(labels).not.toContain("in your own bucket");
    for (const stat of data.stats) expect(INVENTED).not.toContain(stat.value);

    // The two it can count are still counted — one context, no clients.
    expect(data.stats.find((s) => s.label === "contexts reachable")?.value).toBe("1");
    expect(data.stats.find((s) => s.label === "AI clients connected")?.value).toBe("0");
  });

  test("a counted bucket gets the tile, with the number that was counted", () => {
    const { data } = renderSettings(
      withBinding({ ...CONNECTED_BINDING, noteCount: 342, noteCountTruncated: false }),
    );

    expect(data.stats[0]).toEqual({ value: "342", label: "notes across all" });
    // And it has not displaced what was already there.
    expect(data.stats.find((s) => s.label === "contexts reachable")?.value).toBe("1");
  });

  /**
   * A walk that hit its page budget is a floor. Printed as a total it is #25
   * again — a precise-looking number that is not the truth about somebody's
   * bucket — so the `+` is the whole point of the assertion.
   */
  test("a truncated count is marked as a floor, not printed as a total", () => {
    const { data } = renderSettings(
      withBinding({ ...CONNECTED_BINDING, noteCount: 39_000, noteCountTruncated: true }),
    );

    expect(data.stats[0]).toEqual({ value: "39,000+", label: "notes across all" });
  });

  test("a verified empty bucket says zero rather than hiding", () => {
    const { data } = renderSettings(
      withBinding({ ...CONNECTED_BINDING, noteCount: 0, noteCountTruncated: false }),
    );

    expect(data.stats[0]).toEqual({ value: "0", label: "notes across all" });
  });
});

describe("the signed-out demo keeps its invented numbers", () => {
  // The landing page is a demo of a fictional account and says so. Removing the
  // fakes from the live console must not empty the product shot.
  test("the demo storage card still shows the mockup's figures", () => {
    const { data, text } = renderSettings(useDemoConsoleData);
    expect(data.demo).toBe(true);
    expect(text).toContain("1,284 objects");
    expect(text).toContain("PARA structure present");
    expect(text).toContain("Versioning is off");
  });

  test("the demo still has four tiles", () => {
    const { data } = renderSettings(useDemoConsoleData);
    expect(data.stats.map((stat) => stat.value)).toEqual(["3", "4", "1,284", "2.4 GB"]);
  });
});

describe("invented values are structurally out of reach of the live console", () => {
  /**
   * The naming rule from `placeholderData.ts`, enforced rather than described:
   * an invented export is prefixed `DEMO_`, and only the demo path may import
   * one. This is what stops the next person from wiring a constant into the
   * live hook because it was sitting there exported.
   */
  const CONSOLE = join(__dirname, "..", "features", "console");
  const DEMO_PATH = ["placeholderData.ts", "useDemoConsoleData.ts", "files/useDemoFileBrowser.ts"];

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.tsx?$/.test(name) ? [full] : [];
    });
  }

  /** Named bindings pulled in by every `import { … } from "…"` in a file. */
  function importedNames(source: string): string[] {
    const names: string[] = [];
    const imports = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
    for (const match of source.matchAll(imports)) {
      for (const part of match[1].split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (name.length > 0) names.push(name);
      }
    }
    return names;
  }

  test("no module outside the demo path imports a DEMO_ value", () => {
    const offenders = sourceFiles(CONSOLE)
      .map((file) => ({ file, rel: relative(CONSOLE, file).split("\\").join("/") }))
      .filter(({ rel }) => !DEMO_PATH.includes(rel))
      .filter(({ file }) => importedNames(readFileSync(file, "utf8")).some((n) => n.startsWith("DEMO_")));

    expect(offenders.map((o) => o.rel)).toEqual([]);
  });

  test("the demo path is where the invented values actually live", () => {
    // Guards the guard: if the files were renamed or moved, the check above
    // would pass by testing nothing.
    const rels = sourceFiles(CONSOLE).map((f) => relative(CONSOLE, f).split("\\").join("/"));
    for (const demo of DEMO_PATH) expect(rels).toContain(demo);
    const placeholders = readFileSync(join(CONSOLE, "placeholderData.ts"), "utf8");
    expect(placeholders).toContain("export const DEMO_STATS");
  });
});
