import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import {
  PARA_FOLDERS,
  PRODUCT_MANDATED_PATHS,
  isProductMandatedPath,
  scaffoldFiles,
} from "../../functions/lib/scaffold";
import { isPlumbing } from "../../functions/lib/privacy";
import { gatewayInternals } from "../gatewayFormat.helpers";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "../fixtures.helpers";
import {
  scenario,
  teamLink,
} from "./fixtures.helpers";

describe("a folder gets a link too", () => {
  const FOLDER = "1-projects/transition";

  /**
   * A team link is an *address*, and a folder has one — so "a link to this
   * folder" is a sentence that means something. A **personal** share stays
   * note-only: "share this folder with one outsider" would have to decide what
   * a folder share reaches, and "the notes in it, but not its subfolders,
   * unless those are also team" is a rule nobody could predict.
   */
  test("an owner can link a folder", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId, FOLDER);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * **THE test, and the one that reversed a decision.**
   *
   * The rule here was "a folder never carries a title", and its reasoning was
   * sound about the wrong thing. `previewForNote` is unauthenticated, so what
   * licenses it answering at all is that the address is not guessable — and
   * `scaffold.ts` writes `0-inbox`, `1-projects`, `2-areas`, `3-resources` and
   * `4-archive` into every workspace this product creates. Five guesses per handle
   * were enough to learn which of those their owner had team-linked, so folders
   * were refused wholesale.
   *
   * Wholesale was too much. Guessability is a property of a *name*, not of
   * file-versus-folder, and `1-projects/transition` is no more guessable than
   * `1-projects/transition/overview.md` — one is five known values, the other
   * is a name its owner typed, and they are not the same argument. The refusal
   * belonged on the five, and `isProductMandatedPath` is where they now live
   * beside the six scaffolded filenames that were always in it.
   *
   * So: a folder the owner named unfurls with its name.
   */
  test("a folder the owner named unfurls with its name", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId, FOLDER);

    expect(
      await t.query(api.functions.shares.previewForNote, {
        slug: "owner-workspace",
        path: FOLDER,
      }),
    ).toMatchObject({ title: "Transition" });
  });

  /** ...and it gets a card to render that name onto, like any other link. */
  test("and it gets a card", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId, FOLDER);

    expect(
      await t.query(api.functions.shares.previewForNote, {
        slug: "owner-workspace",
        path: FOLDER,
      }),
    ).toMatchObject({ cardToken: token });
  });

  /**
   * The half of the reversal that is still a refusal: the five names the
   * product wrote itself. This drives `PARA_FOLDERS` rather than restating it,
   * for the reason the scaffolded-files case below gives — a sixth folder would
   * otherwise become a sixth guess in silence.
   */
  test.each([...PARA_FOLDERS])(
    "%s is a folder anybody can guess, so its card stays frozen",
    async (path) => {
      const t = setupTest();
      const { ownerId, workspaceId } = await scenario(t);
      await teamLink(t, ownerId, workspaceId, path);

      expect(
        await t.query(api.functions.shares.previewForNote, { slug: "owner-workspace", path }),
      ).toEqual({ title: null, cardToken: null, children: [] });
    },
  );

  /**
   * The guard's SHAPE, which the two cases above do not pin between them:
   * `isProductMandatedPath` matches a scaffolded name **exactly**, and relaxing
   * that to `startsWith` — the obvious way to write "and everything under it" —
   * would silently freeze every note in the workspace, since every one of them is
   * under a PARA folder. Both fixtures below are owner-chosen names that a
   * prefix match would swallow.
   */
  test.each([
    ["1-projects-archive", "a folder whose name begins with a scaffolded one"],
    ["1-projects/overview.md", "a note inside a scaffolded folder"],
  ])("%s still previews (%s)", async (path) => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId, path);

    const answer = await t.query(api.functions.shares.previewForNote, {
      slug: "owner-workspace",
      path,
    });
    expect(answer.title).not.toBeNull();
  });

  test.each([
    // A path that is not a note and not a folder either. The rule is neither
    // "ends in .md" nor "has no extension" — it is "the owner named it" — and
    // an attachment the owner linked is a name the owner chose.
    ["1-projects/a.md.png", "A.md.png"],
    ["1-projects/x.mdx", "X.mdx"],
    // "UPPER", not "Upper": `titleFromPath` uppercases the first character and
    // leaves the rest, which is what a note called README deserves. Measured —
    // the first version of this line predicted title-casing and was wrong.
    ["1-projects/UPPER.MD", "UPPER"],
    ["1-projects/a.png.md", "A.png"],
  ])("%s previews as %s", async (path, title) => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId, path);

    expect(
      await t.query(api.functions.shares.previewForNote, { slug: "owner-workspace", path }),
    ).toMatchObject({ title });
  });

  /**
   * The note-only rule's own premise, which the cases above assume rather than
   * check: that a note FILENAME is not guessable.
   *
   * For a fresh workspace that is false, and by more than one file. `scaffoldFiles`
   * writes `privacy.md`, `index.md`, and a `README.md` into every one of the
   * five PARA folders — six guessable note names before the owner has written
   * anything — and the connected-client house rules put a `todo.md` at the
   * root. That is the same exhaustible space the five folder names are, so it
   * gets the same answer.
   *
   * This drives `scaffoldFiles` instead of restating its output on purpose: a
   * seventh scaffolded file would otherwise become a seventh guess silently,
   * and the whole reason this rule exists is that somebody counted the folders
   * once and never counted again.
   */
  test.each([
    ...scaffoldFiles("para")
      .map((file) => file.key)
      // `privacy.md` is in that list and cannot be team-linked at all —
      // `checkTeamSharePath` refuses plumbing long before the preview is
      // reached, so there is no share row for this to be asked about.
      .filter((key) => key.toLowerCase().endsWith(".md") && !isPlumbing(key)),
    "todo.md",
  ])("%s is a name anybody can guess, so its card stays frozen", async (path) => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId, path);

    expect(
      await t.query(api.functions.shares.previewForNote, { slug: "owner-workspace", path }),
    ).toEqual({ title: null, cardToken: null, children: [] });
  });

  /**
   * The folder names the PRODUCT picks, which are not the five PARA ones.
   *
   * `#163` was right that guessability is a property of a name rather than of
   * file-versus-folder — `1-projects/transition` is exactly as unguessable as
   * the note inside it — and replaced a blanket `.md` refusal with a list.
   * Blanket rules hide their own edges, though, and the `.md` test had been
   * covering one: the session folder the gateway writes into is chosen by US,
   * not by the owner.
   *
   * `defaultSessionFolder` in `apps/mcp/src/index.js` returns
   * `4-archive/chat-history` when the manifest has a `4-archive` rule and
   * `0-inbox/sessions` otherwise, so every workspace whose owner has ever run
   * `save_context` has one of them. Two guesses per handle, on names nobody
   * chose, which is the same shape as the five PARA folders and gets the same
   * answer.
   *
   * The nested platform folder beneath (`<folder>/<platform>/`) is a third
   * name we pick, but it only exists under one of these two, so refusing the
   * parent is where the bound belongs.
   */
  test.each([
    "4-archive/chat-history",
    "0-inbox/sessions",
  ])("%s is a folder this product named, not its owner", async (path) => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId, path);

    expect(
      await t.query(api.functions.shares.previewForNote, { slug: "owner-workspace", path }),
    ).toEqual({ title: null, cardToken: null, children: [] });
  });

  /**
   * The gateway-written names are tied to their writers, not restated beside
   * them.
   *
   * This list has now shipped short four times — folders, the `.md` product
   * names, the session folders, and the hook capture folders — and each time
   * the fix was to add literals. Literals are unavoidable here (`apps/convex`
   * cannot import the Worker or the hook package), so what closes the loop is
   * reading the writers and asserting the list covers what they produce. That
   * is what `scaffoldFiles` already gets, and what these did not.
   */
  /**
   * **Driven, not parsed.** This read the function's source and pulled the
   * string literals out of its `return`, which worked only while the answer
   * *was* a literal. It stopped being one when `defaultSessionFolder` learned
   * to resolve the archive folder instead of assuming `4-archive`, and a
   * source-shape regex fails loudly at that change — which is the good
   * direction, but it was never checking the thing it claimed. Running the
   * real function over the real manifests does.
   */
  test("every folder `defaultSessionFolder` can return is in the list", () => {
    const { defaultSessionFolder } = gatewayInternals();

    // Every archive root this product ships, one layout each, plus the
    // no-archive case. Read out of `presets.ts` as text rather than imported,
    // for the reason the neighbouring preset check gives: `apps/mobile`'s
    // tsconfig is not installed in every job that runs this suite.
    const presets = readFileSync(
      new URL("../../../mobile/features/workspace/presets.ts", import.meta.url),
      "utf8",
    );
    const presetFolders = [...presets.matchAll(/folder:\s*"([^"]+)"/g)].map((m) => m[1]!);
    const shipped = [...new Set([...PARA_FOLDERS, ...presetFolders])];
    const archiveRoots = shipped.filter((folder) => /^(?:\d+-)?archive$/i.test(folder));
    expect(
      archiveRoots.length,
      "no archive root found — presets.ts or PARA_FOLDERS changed shape",
    ).toBeGreaterThanOrEqual(2);

    // One root per layout, deliberately: a layout carrying both would resolve
    // to whichever the resolver prefers and never exercise the other.
    const layouts = [...archiveRoots.map((root) => [root]), ["Journal", "Clients"]];

    const returned = new Set<string>();
    for (const folders of layouts) {
      returned.add(
        defaultSessionFolder(folders.map((prefix) => ({ prefix, vis: "private" }))),
      );
    }

    // Non-vacuity: the archive branch and the fallback both have to be here, or
    // this passes by only ever exercising one of them.
    expect(returned.has("0-inbox/sessions")).toBe(true);
    expect([...returned].some((folder) => folder.endsWith("/chat-history"))).toBe(true);
    // And the preset default is the case that was broken: `company` ships
    // `5-archive`, and its sessions went to `0-inbox/sessions` because the
    // resolver was looking for a `4-archive` that layout never had.
    expect(returned.has("5-archive/chat-history")).toBe(true);

    for (const folder of returned) expect(PRODUCT_MANDATED_PATHS).toContain(folder);
  });

  test("and every client the hook installs has its capture folder in the list", () => {
    const install = readFileSync(
      new URL("../../../../packages/hook/src/install.js", import.meta.url),
      "utf8",
    );
    // `writeInboxCapture` files an `external_id` capture under
    // `0-inbox/<safeSlug(source)>/`, and the hook's source is `hook:<id>`.
    //
    // This pins ONE of the four inputs to that folder name — the roster, which
    // is the one most likely to move. It does not read the `hook:` prefix in
    // `transcript.js`, nor `safeSlug`, nor the `0-inbox/` prefix. Measured:
    // changing the prefix to `context-hook:` leaves the suite green while every
    // real capture folder falls off the list. Stated rather than implied,
    // because a guard that reads one input of four looks like it reads all of
    // them.
    //
    // `0-inbox/inbox`, `0-inbox/granola` and `0-inbox/capture` have no
    // writer-driven check at all: they are pinned only by the router mirror,
    // which says "the two copies disagree" and never "the list is short". When
    // both copies were short, as they were before this PR, nothing fired.
    const ids = [...install.matchAll(/^\s{4}id: "([a-z0-9-]+)",$/gm)].map((m) => m[1]);

    expect(ids.length).toBeGreaterThan(2);
    for (const id of ids) expect(PRODUCT_MANDATED_PATHS).toContain(`0-inbox/hook-${id}`);
  });

  /**
   * THE PRESET FOLDERS ARE OURS TOO, AND THE `custom` PATH HID THAT.
   *
   * `isProductMandatedPath` refuses a preview for every path the product
   * writes, on the ground that such a name is a guess anybody can make without
   * knowing the owner. `scaffold.ts` states the exception in its own words: the
   * `custom` template is out of scope "because those folder names are the
   * owner's — `Journal/`, `Clients/` — so the guessability premise simply does
   * not hold for them."
   *
   * #203 falsified that premise. `apps/mobile/features/workspace/presets.ts`
   * ships two fixed folder lists, `templateFor` sends them down the **custom**
   * path, and `DEFAULT_PRESET` is `company` — so they are what a workspace gets
   * when nobody chooses. `2-teams`, `3-handbook`, `4-customers`, `5-archive`,
   * `1-clients`, `2-pipeline` and `3-practice` are now names this product
   * writes, at addresses anybody who knows a handle can type.
   *
   * And the same PR made it bite harder: a shared context's scaffold starts
   * those folders `team`, so `snapshotChildren` at team scope actually returns
   * contents. Before it, a folder card on a fresh context mostly named nothing.
   *
   * **Driven by the writer, not restated here.** The preset file is read as
   * text — the way the check above reads the hook roster and the one below
   * reads the router's mirror — because a list retyped in a test is a second
   * guess about the same thing. It is text rather than an import on purpose:
   * `apps/mobile` carries a tsconfig extending `expo/tsconfig.base`, which is
   * not installed in every job that runs this suite, and a guard that is green
   * locally and red in CI for a reason unrelated to what it checks is worse
   * than no guard.
   */
  test("every folder a workspace preset writes is refused a preview", () => {
    const presets = readFileSync(
      new URL(
        "../../../mobile/features/workspace/presets.ts",
        import.meta.url,
      ),
      "utf8",
    );

    const folders = [...presets.matchAll(/folder:\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(
      new Set(folders).size,
      "presets.ts no longer declares folders in the shape this reads",
    ).toBeGreaterThanOrEqual(7);

    for (const folder of new Set(folders)) {
      expect(
        PRODUCT_MANDATED_PATHS,
        `${folder} is a folder this product writes and must not unfurl`,
      ).toContain(folder);
      expect(
        PRODUCT_MANDATED_PATHS,
        `${folder}/README.md is written by the scaffold and must not unfurl`,
      ).toContain(`${folder}/README.md`);
    }
  });

  /**
   * **A canary, not a scan, and the difference is the point.**
   *
   * `store.put("<N>-folder/...")` matches the one literal form the gateway
   * uses today, so reformatting that line fires — which is what makes it worth
   * having. It does NOT see a template literal, a line break after `put(`,
   * single quotes, a hoisted constant, or a path built by a helper. Measured:
   * injecting ``store.put(`2-areas/calendar/agenda-${d}.md`, md)`` leaves the
   * whole suite green.
   *
   * The template-literal blindness is the one that matters, because
   * `0-inbox/${sourceSlug}/` and `${folder}/${platform}/` — the writers behind
   * the fourth omission and the named residual — are exactly that shape. A new
   * hardcoded path is caught; a new computed one is not, and no regex over
   * source will change that.
   *
   * It also reads `index.js` alone. Generated notes pass through
   * `writeGeneratedNote`, the collaboration-aware write seam, while the
   * remaining dot-prefixed writes are plumbing refused by `isPlumbing`.
   */
  test("and the calendar path the cron hardcodes", () => {
    const gateway = readFileSync(
      new URL("../../../mcp/src/index.js", import.meta.url),
      "utf8",
    );
    expect(gateway).toMatch(
      /writeGeneratedNote\(\s*store,\s*"2-areas\/calendar\/next-14-days\.md"/s,
    );
    expect(PRODUCT_MANDATED_PATHS).toContain("2-areas/calendar/next-14-days.md");
  });

  /**
   * The router's restated copy really does restate this one.
   *
   * `infra/router/src/preview/notes.ts` refuses the same names to save a round
   * trip, and it holds a hand-written literal because it is a separate
   * deployment that cannot import this module. The comment there claimed the
   * two were "held together by running both against the same names"; they were
   * not, and a comment claiming a check nobody wrote is the thing that went
   * wrong one commit ago in `listFolder`. So here is the check.
   *
   * It reads the router's source rather than importing it, which is what the
   * mobile scope mirror does in `__tests__/consentScopes.test.ts` for the same
   * reason. Drift is not dangerous — the derived copy here is authoritative, so
   * a stale router costs a wasted round trip and never a title — but it is
   * silent, and silent is how the folder count stayed at five.
   *
   * (`PRODUCT_MANDATED_PATHS` moved from `infra/router/src/preview.ts` — a
   * facade now — into `infra/router/src/preview/notes.ts`, where it lives next
   * to the two functions that read it. This test was repointed at the new
   * file; the assertion is unchanged.)
   */
  test("the edge router refuses exactly the same names", () => {
    const source = readFileSync(
      new URL("../../../../infra/router/src/preview/notes.ts", import.meta.url),
      "utf8",
    );
    const literal = source.match(/const PRODUCT_MANDATED_PATHS = new Set\(\[([^\]]*)\]\)/);
    expect(literal, "PRODUCT_MANDATED_PATHS is not a literal Set in preview.ts").not.toBeNull();
    const routed = [...literal![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

    // The predicate's own list, not a third restatement of it. This array used
    // to be written out here, so the test held the router's copy against a copy
    // of its own and never asked the predicate — and adding a path to the
    // predicate left it green with the router short.
    expect([...routed].sort()).toEqual([...PRODUCT_MANDATED_PATHS].sort());
    // ...and the literal is not merely equal to the list, it is equal to what
    // the predicate actually does, which is the thing the router is mirroring.
    for (const path of routed) expect(isProductMandatedPath(path)).toBe(true);
  });

  /**
   * ...and a name the OWNER chose still carries its title, which is the whole
   * point. A rule that refused every note would have been the frozen card back.
   */
  test("while a name the owner chose still previews", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId, "1-projects/acme-migration.md");

    expect(
      await t.query(api.functions.shares.previewForNote, {
        slug: "owner-workspace",
        path: "1-projects/acme-migration.md",
      }),
      // "Acme migration": `titleFromPath` uppercases the first character and
      // turns hyphens into spaces. Measured — a first guess here said
      // "Acme-migration", which is the same mistake the `UPPER` comment above
      // records, made a second time by predicting instead of running it.
    ).toMatchObject({ title: "Acme migration" });
  });

  /**
   * And a scaffolded folder's refusal is byte-identical to every other one, so
   * a probe cannot tell "they team-linked `1-projects`" from "no such handle".
   * This is the property the whole rule exists to produce; without it, naming
   * the five names would only move the oracle rather than close it.
   */
  test("and that refusal is the same one an unknown handle gets", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId, PARA_FOLDERS[1]);

    const folder = await t.query(api.functions.shares.previewForNote, {
      slug: "owner-workspace",
      path: PARA_FOLDERS[1],
    });
    const stranger = await t.query(api.functions.shares.previewForNote, {
      slug: "nobody-at-all",
      path: PARA_FOLDERS[1],
    });
    expect(folder).toEqual(stranger);
  });

  test("a member opens it and a stranger does not", async () => {
    const t = setupTest();
    const { ownerId, memberId, strangerId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId, FOLDER);

    expect(
      await asUser(t, memberId).query(api.functions.shares.resolveShare, { token }),
    ).not.toBeNull();
    expect(
      await asUser(t, strangerId).query(api.functions.shares.resolveShare, { token }),
    ).toBeNull();
  });

  /**
   * The refusal that survives the folder relaxation. `.history/` is every
   * revision of every note and `privacy.md` is the access map; widening the
   * path check to allow folders must not widen it to those.
   */
  test.each([
    [".history", "the history store"],
    [".history/1-projects", "a folder inside it"],
    [".images", "the image store"],
    ["privacy.md", "the access map"],
  ])("%s cannot be linked (%s)", async (path) => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    expect(
      errorCode(await captureError(() => teamLink(t, ownerId, workspaceId, path))),
    ).toBe("PATH_NOT_SHAREABLE");
  });

  /**
   * The axis the fixtures above hold constant: every path in them is a note, a
   * folder, or plumbing. The rule as written is none of those three — it is
   * "anything that is not plumbing" — and narrowing it to what its own comment
   * described ("a note, or a path with no extension") passed all 1,374 checks.
   *
   * So this pins what the code actually does. A member can already read a
   * non-note file at their tier, and a team link grants nothing, so linking one
   * is no escalation — but the rule should be held as written rather than as
   * imagined, in both directions: wide enough for an attachment, and still
   * refusing plumbing.
   */
  test("a non-note file can be linked too, because the rule is 'not plumbing'", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId, "1-projects/diagram.png");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  /** A personal share is still note-only. */
  test("a non-note file cannot be shared with one person either", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const lk = await createUser(t, "lk2@example.invalid");
    await createWorkspace(t, lk, "lk2");

    expect(
      errorCode(
        await captureError(() =>
          asUser(t, ownerId).mutation(api.functions.shares.createShare, {
            workspaceId,
            path: "1-projects/diagram.png",
            recipient: "@lk2",
          }),
        ),
      ),
    ).toBe("PATH_NOT_SHAREABLE");
  });

  /** A personal share is still note-only. */
  test("a folder cannot be shared with one person", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const lk = await createUser(t, "lk@example.invalid");
    await createWorkspace(t, lk, "lk");

    expect(
      errorCode(
        await captureError(() =>
          asUser(t, ownerId).mutation(api.functions.shares.createShare, {
            workspaceId,
            path: FOLDER,
            recipient: "@lk",
          }),
        ),
      ),
    ).toBe("PATH_NOT_SHAREABLE");
  });
});
