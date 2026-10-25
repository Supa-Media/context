import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { type FileStore, movePath, readFile } from "../../functions/lib/fileOps";
import { normalizePath, requirePath } from "../../functions/lib/fileOps/paths";
import {
  PRIVACY_KEY,
  type Visibility,
  replacePrivacyRulesBlock,
} from "../../functions/lib/privacy";
import {
  type MemoryStore,
  memoryStore,
} from "../storeStub.helpers";
import { NOW, capture, names, shareProjects } from "./fixtures.helpers";
import { keyedBucket } from "../keyedFixture.fileops2.helpers";
import { setFolderVisibility, setVisibility, renderPrivacyManifest } from "../seededRules.helpers";
import { rowRulesIn } from "./keyedFixture.fileops1.helpers";
import { internal } from "../../_generated/api";
import { nodeAt as treeNodeAt } from "../../functions/lib/nodes/paths";

/** The folder rule a prefix carries in the rows, or `undefined`. */
async function folderRuleOf(k: { t: Parameters<typeof rowRulesIn>[0]; ws: Parameters<typeof rowRulesIn>[1] }, prefix: string) {
  const { rules } = await rowRulesIn(k.t, k.ws);
  return rules.find((rule) => rule.prefix === prefix)?.vis;
}

/**
 * The token a row that names a group carries in the rendered rules: `@#<noteId>`, derived from the row's own id, never
 * the group's name (`lib/nodes/rowAccess.ts`).
 */
async function groupTokenOf(k: { t: Parameters<typeof rowRulesIn>[0]; ws: Parameters<typeof rowRulesIn>[1] }, path: string): Promise<string> {
  const noteId = await k.t.run(async (ctx) => {
    const rows = [await treeNodeAt(ctx.db, k.ws, path)].flatMap((row) =>
      row === null ? [] : [row],
    );
    return rows.find((row) => row.goneAt === undefined)?.noteId;
  });
  if (noteId === undefined) throw new Error(`no live note row at ${path}`);
  return `@#${noteId}`;
}

/**
 * Renaming a folder must not publish what the arriving one held back.
 *
 * `oneRulePerPrefix` resolves the collision a folder rename creates when both
 * the source and the destination already carry a rule for the same subfolder.
 * Its docblock says the collision "is resolved in the only direction that
 * cannot leak", and the test it was written with was
 * `existing.vis === "team" && rule.vis === "private"` — which WAS that
 * direction while there were two values, and stopped being it the day a rule
 * could name a group. Nothing in that test narrows `team` to a group.
 *
 * Found by an adversarial review of the change that introduced group rules,
 * not by this suite, which is why it is pinned in the shape the review used:
 * the natural alphabetical order `renderPrivacyRulesBlock` emits, no
 * hand-editing beyond the group rule itself.
 */
describe("a folder rename keeps the narrower of two colliding rules", () => {
  function manifestWith(lines: string[]): string {
    return replacePrivacyRulesBlock(
      renderPrivacyManifest("para"),
      lines.map((line) => {
        const [prefix, vis] = line.split(": ");
        return { prefix, vis: vis as Visibility };
      }),
      new Map(),
    );
  }

  test("a group rule arriving over a team one survives the move", async () => {
    const k = await keyedBucket(async (store) => {
      store.seed(
        PRIVACY_KEY,
        manifestWith([
          "1-projects/dst: private",
          "1-projects/dst/hr: team",
          "1-projects/src: private",
          "1-projects/src/hr: @supa-leads",
        ]),
      );
      store.seed("1-projects/src/hr/comp.md", "# Comp\n");
    });

    await movePath(k.store, {
      from: "1-projects/src",
      to: "1-projects/dst",
      clearance: clearanceOf("private"),
      now: NOW,
    });

    // The moved folder's row carries its group with it, so the rule at its new name is that row's token.
    expect(await folderRuleOf(k, "1-projects/dst/hr")).toBe(await groupTokenOf(k, "1-projects/dst/hr"));

    // The consequence, stated as the thing that actually matters: a team
    // connection still cannot read what moved.
    const leak = await capture(() =>
      readFile(k.store, { path: "1-projects/dst/hr/comp.md", clearance: clearanceOf("team") }),
    );
    expect(leak.code).toBe("FILE_NOT_FOUND");
  });

  test("the two tiers still collide exactly as they did", async () => {
    const k = await keyedBucket(async (store) => {
      store.seed(
        PRIVACY_KEY,
        manifestWith([
          "1-projects/dst: private",
          "1-projects/dst/hr: team",
          "1-projects/src: private",
          "1-projects/src/hr: private",
        ]),
      );
      store.seed("1-projects/src/hr/comp.md", "# Comp\n");
    });

    await movePath(k.store, {
      from: "1-projects/src",
      to: "1-projects/dst",
      clearance: clearanceOf("private"),
      now: NOW,
    });

    expect(await folderRuleOf(k, "1-projects/dst/hr")).toBe("private");
  });

});

/**
 * A group value reaching the rules through the ordinary writer.
 *
 * `setNoteGroup` in `functions/files.ts` proves the NAME belongs to this
 * workspace and then dispatches here; this is the other half — that the writer
 * treats a group like any other narrowing, which it has since #418 taught
 * `Visibility` a third case. The rules are judged from the rows.
 */
describe("a note can be pointed at a group", () => {
  test("the rule lands in the rows as an exception", async () => {
    const k = await keyedBucket(async (store) => {
      await shareProjects(store);
    });

    const result = await setVisibility(k.store, {
      path: "1-projects/context-lc.md",
      visibility: "@supa-leads" as Visibility,
      clearance: clearanceOf("private"),
    });

    expect(result.visibility).toBe("@supa-leads");
    // An exception, because the folder is `team` and this is not.
    expect(result.exception).toBe(true);
    const { overrides } = await rowRulesIn(k.t, k.ws);
    expect(overrides.get("1-projects/context-lc.md")?.startsWith("@#")).toBe(true);
  });

  test("and a team connection cannot read it afterwards", async () => {
    const k = await keyedBucket(async (store) => {
      await shareProjects(store);
    });
    // Non-vacuity: readable by the team BEFORE the rule lands.
    expect(
      (await readFile(k.store, { path: "1-projects/context-lc.md", clearance: clearanceOf("team") })).visibility,
    ).toBe("team");

    await setVisibility(k.store, {
      path: "1-projects/context-lc.md",
      visibility: "@supa-leads" as Visibility,
      clearance: clearanceOf("private"),
    });

    const refused = await capture(() =>
      readFile(k.store, { path: "1-projects/context-lc.md", clearance: clearanceOf("team") }),
    );
    expect(refused.code).toBe("FILE_NOT_FOUND");
  });

  test("pointing it back at its folder's default removes the exception", async () => {
    const k = await keyedBucket(async (store) => {
      await shareProjects(store);
    });
    await setVisibility(k.store, {
      path: "1-projects/context-lc.md",
      visibility: "@supa-leads" as Visibility,
      clearance: clearanceOf("private"),
    });
    // The rows writer the console calls (`nodesAccess.consoleAccess`) is what takes a group off a row; the seeded
    // text only sets rows, it never clears one. The owner is the workspace's creator, as the translator reads it.
    const owner = await k.t.run(async (ctx) => (await ctx.db.get(k.ws))!.createdBy);
    const back = await k.t.mutation(internal.functions.nodesAccess.consoleAccess, {
      workspaceId: k.ws,
      actorUserId: owner,
      path: "1-projects/context-lc.md",
      kind: "note",
      tier: "team",
    });
    expect(back).toMatchObject({ ok: true, exception: false });
    // The note is back on the team's terms: no group token left on its row, and the team reads it again.
    const { overrides } = await rowRulesIn(k.t, k.ws);
    expect(overrides.get("1-projects/context-lc.md") ?? "team").toBe("team");
    expect((await readFile(k.store, { path: "1-projects/context-lc.md", clearance: clearanceOf("team") })).visibility).toBe("team");
  });
});

/**
 * A PATH MAY NOT CARRY A CONTROL CHARACTER INTO A RULE.
 *
 * `#422` fixed this when the rules were a line-oriented file: a path carrying a
 * newline wrote extra rules, publishing a note the call never named, while the
 * call declared `private` so no confirmation was asked for. The rules are rows
 * now and nothing is rendered line by line, but every path a rule names still
 * passes the normaliser, which refuses a control character whatever key the
 * bucket holds (`lib/fileOps/paths.ts`). These pin that refusal.
 */
describe("a path cannot carry a control character into a rule", () => {
  test("a folder name carrying a newline is refused, not split into two rules", () => {
    expect(normalizePath("2-areas/hr: team\n  1-projects/junk")).toBeNull();
    expect(() => requirePath("2-areas/hr: team\n  1-projects/junk")).toThrow();
  });

  test("a note path carrying a newline is refused", () => {
    expect(normalizePath("2-areas/hr/salaries.md: team\n  1-projects/junk.md")).toBeNull();
  });

  test("a control character is refused even when it would round-trip", () => {
    expect(normalizePath("2-areas/hr/sal\u0009aries.md")).toBeNull();
  });

  /** Non-vacuity: an ordinary path still normalises. */
  test("an ordinary path is still accepted", () => {
    expect(normalizePath("2-areas/hr/salaries.md")).toBe("2-areas/hr/salaries.md");
  });
});
