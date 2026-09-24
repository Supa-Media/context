import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import {
  FileOpError,
  type FileStore,
  movePath,
  readFile,
  setFolderVisibility,
  setVisibility,
} from "../../functions/lib/fileOps";
import {
  PRIVACY_KEY,
  type Visibility,
  canSee,
  parsePrivacyManifest,
  replacePrivacyRulesBlock,
} from "../../functions/lib/privacy";
import { renderPrivacyManifest } from "../../functions/lib/scaffold";
import {
  type MemoryStore,
  memoryStore,
} from "../storeStub.helpers";
import {
  NOW,
  bucket,
  shareProjects,
  capture,
  names,
} from "./fixtures";

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
    const store = bucket();
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

    await movePath(store, {
      from: "1-projects/src",
      to: "1-projects/dst",
      clearance: clearanceOf("private"),
      now: NOW,
    });

    const manifest = store.snapshot()[PRIVACY_KEY];
    expect(manifest).toContain("1-projects/dst/hr: @supa-leads");
    expect(manifest).not.toContain("1-projects/dst/hr: team");

    // The consequence, stated as the thing that actually matters: a team
    // connection still cannot read what moved.
    const leak = await capture(() =>
      readFile(store, { path: "1-projects/dst/hr/comp.md", clearance: clearanceOf("team") }),
    );
    expect(leak.code).toBe("FILE_NOT_FOUND");
  });

  test("two different groups colliding resolve to private, not to whichever came first", async () => {
    const store = bucket();
    store.seed(
      PRIVACY_KEY,
      manifestWith([
        "1-projects/dst: private",
        "1-projects/dst/hr: @supa-owners",
        "1-projects/src: private",
        "1-projects/src/hr: @supa-leads",
      ]),
    );
    store.seed("1-projects/src/hr/comp.md", "# Comp\n");

    await movePath(store, {
      from: "1-projects/src",
      to: "1-projects/dst",
      clearance: clearanceOf("private"),
      now: NOW,
    });

    const manifest = store.snapshot()[PRIVACY_KEY];
    expect(manifest).toContain("1-projects/dst/hr: private");
    expect(manifest).not.toContain("@supa-owners");
    expect(manifest).not.toContain("@supa-leads");
  });

  test("the two tiers still collide exactly as they did", async () => {
    const store = bucket();
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

    await movePath(store, {
      from: "1-projects/src",
      to: "1-projects/dst",
      clearance: clearanceOf("private"),
      now: NOW,
    });

    expect(store.snapshot()[PRIVACY_KEY]).toContain("1-projects/dst/hr: private");
  });
});

/**
 * A group value reaching `privacy.md` through the ordinary writer.
 *
 * `setNoteGroup` in `functions/files.ts` proves the NAME belongs to this
 * workspace and then dispatches here; this is the other half — that the writer
 * treats a group like any other narrowing, which it has since #418 taught
 * `Visibility` a third case. Beside the writer because this is where there is
 * a store to write to.
 */
describe("a note can be pointed at a group", () => {
  test("the rule lands in the manifest as an exception", async () => {
    const store = bucket();
    await shareProjects(store);

    const result = await setVisibility(store, {
      path: "1-projects/context-lc.md",
      visibility: "@supa-leads" as Visibility,
      clearance: clearanceOf("private"),
    });

    expect(result.visibility).toBe("@supa-leads");
    // An exception, because the folder is `team` and this is not.
    expect(result.exception).toBe(true);
    expect(store.snapshot()[PRIVACY_KEY]).toContain("1-projects/context-lc.md: @supa-leads");
  });

  test("and a team connection cannot read it afterwards", async () => {
    const store = bucket();
    await shareProjects(store);
    // Non-vacuity: readable by the team BEFORE the rule lands.
    expect(
      (await readFile(store, { path: "1-projects/context-lc.md", clearance: clearanceOf("team") })).visibility,
    ).toBe("team");

    await setVisibility(store, {
      path: "1-projects/context-lc.md",
      visibility: "@supa-leads" as Visibility,
      clearance: clearanceOf("private"),
    });

    const refused = await capture(() =>
      readFile(store, { path: "1-projects/context-lc.md", clearance: clearanceOf("team") }),
    );
    expect(refused.code).toBe("FILE_NOT_FOUND");
  });

  test("pointing it back at its folder's default removes the exception", async () => {
    const store = bucket();
    await shareProjects(store);
    await setVisibility(store, {
      path: "1-projects/context-lc.md",
      visibility: "@supa-leads" as Visibility,
      clearance: clearanceOf("private"),
    });
    const back = await setVisibility(store, {
      path: "1-projects/context-lc.md",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    expect(back.exception).toBe(false);
    expect(store.snapshot()[PRIVACY_KEY]).not.toContain("@supa-leads");
  });
});

/**
 * A NOTE PATH MAY NOT WRITE ITS OWN PRIVACY RULES — THROUGH THIS DOOR EITHER.
 *
 * `#422` fixed exactly this in the gateway: `privacy.md` is line-oriented and
 * `renderPrivacyRulesBlock` interpolates a path into it unescaped, so a path
 * carrying a newline writes extra rules — publishing a note the call never
 * named, while the call declared `private` so no confirmation was asked for.
 *
 * The control plane renders the same format from the same shaped code and was
 * not changed. Its `writableAsRule` — which the gateway's new comment cites as
 * the technique it is copying — guards `rootFolders`, the manifest *repair*
 * path, and is not reached by either visibility setter. `normalizePath` here
 * strips slashes and dot segments and `.trim()`s the ends; an interior control
 * character survives all of it.
 *
 * The hostile input is a **key in the bucket**, not the owner's typing. The
 * repo says so itself, in `writableAsRule`'s own docstring: *"A newline. A
 * legal S3 key character, and a name carrying one appends whatever it likes to
 * `folder_defaults`. The useful thing to append is `: team`."* Obsidian sync,
 * rclone and the provider console all write keys directly. The owner then
 * clicks that folder in the console and sets it private — and publishes
 * something else.
 */
describe("a path cannot inject rules into privacy.md", () => {
  async function bucket(): Promise<MemoryStore & FileStore> {
    const store = memoryStore() as MemoryStore & FileStore;
    store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
    store.seed("2-areas/hr/salaries.md", "# Salaries\n");
    store.seed("1-projects/README.md", "# Projects\n");
    return store;
  }

  function teamVisible(store: MemoryStore, path: string): boolean {
    const parsed = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]!);
    return canSee(path, "team", parsed.rules, parsed.overrides);
  }

  /**
   * MEASURED BEFORE THE FIX: this published `2-areas/hr` to the whole team.
   *
   * The injected rule is DEEPER than the real one, so longest-prefix hands it
   * the answer outright. A shallower injection is caught by nothing — it just
   * loses the tie — which is ordering doing a guard's job by accident.
   */
  test("a folder name carrying a newline does not publish a folder it never named", async () => {
    const store = await bucket();
    expect(teamVisible(store, "2-areas/hr/salaries.md")).toBe(false);

    await expect(
      setFolderVisibility(store, {
        // The victim comes first and carries the value; the tail keeps the
        // second rendered line well formed, so the manifest stays parseable
        // and the injection is a publish rather than a broken file.
        path: "2-areas/hr: team\n  1-projects/junk",
        visibility: "private",
        clearance: clearanceOf("private"),
      }),
    ).rejects.toThrow(FileOpError);

    expect(teamVisible(store, "2-areas/hr/salaries.md")).toBe(false);
  });

  /**
   * MEASURED BEFORE THE FIX: `note_overrides` ended up holding the victim
   * twice — `private`, then the injected `team` — and the later line won.
   *
   * The call declares `private`, which is why this matters: the console asks
   * for a publish confirmation on a widening change and this is not one.
   */
  test("a note path carrying a newline does not publish a note it never named", async () => {
    const store = await bucket();
    await setFolderVisibility(store, {
      path: "2-areas",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    await setVisibility(store, {
      path: "2-areas/hr/salaries.md",
      visibility: "private",
      clearance: clearanceOf("private"),
    });
    expect(teamVisible(store, "2-areas/hr/salaries.md")).toBe(false);

    await expect(
      setVisibility(store, {
        path: "2-areas/hr/salaries.md: team\n  1-projects/junk.md",
        visibility: "private",
        clearance: clearanceOf("private"),
      }),
    ).rejects.toThrow(FileOpError);

    expect(teamVisible(store, "2-areas/hr/salaries.md")).toBe(false);
  });

  /**
   * THE SECOND LAYER, WITH NO CONTROL CHARACTER IN SIGHT.
   *
   * `2-areas/pay: team` is a legal S3 key. Rendered as `  <path>: private` the
   * parser's `[^:]+?` stops at the first colon, so the rule names
   * `2-areas/pay` — a different note — and reads back fine. A character
   * blacklist cannot see this; rendering and re-parsing can.
   */
  test("a path the rule grammar would read as a different path is refused", async () => {
    const store = await bucket();
    await expect(
      setVisibility(store, {
        path: "2-areas/pay: team.md",
        visibility: "private",
        clearance: clearanceOf("private"),
      }),
    ).rejects.toThrow(FileOpError);
    await expect(
      setFolderVisibility(store, {
        path: "2-areas/pay: team",
        visibility: "private",
        clearance: clearanceOf("private"),
      }),
    ).rejects.toThrow(FileOpError);
  });

  /**
   * THE CONTROL-CHARACTER LAYER, ON ITS OWN TERMS — AND WHAT IT IS NOT.
   *
   * Measured: deleting that refusal leaves every other test here green,
   * because the round trip already catches both newline payloads. So it is
   * **not** a second independent guard against injection, and claiming it was
   * would be a guard nobody has checked wearing a second guard's evidence.
   *
   * What it is: the thing that keeps the two engines refusing the same set.
   * `#422` added exactly this rejection to the gateway, and two engines
   * writing one format diverging on what they accept is how a note becomes
   * settable through one door and not the other. A tab round-trips through the
   * parser perfectly well, so only this layer refuses it — which is what makes
   * it measurable at all.
   */
  test("a control character is refused even when it would round-trip", async () => {
    const store = await bucket();
    await expect(
      setVisibility(store, {
        path: "2-areas/hr/sal\u0009aries.md",
        visibility: "team",
        clearance: clearanceOf("private"),
      }),
    ).rejects.toThrow(FileOpError);
  });

  /** Non-vacuity: an ordinary path still goes through both layers. */
  test("an ordinary path is still writable", async () => {
    const store = await bucket();
    await setFolderVisibility(store, {
      path: "2-areas/hr",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    expect(teamVisible(store, "2-areas/hr/salaries.md")).toBe(true);
  });
});
