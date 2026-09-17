/**
 * A FOLDER LINK, AND THE SUBTREE IT REACHES.
 *
 * Asked for by the owner (2026-09-17) on an explicit comparison: Google Drive
 * and Dropbox both give a folder link the *whole subtree* — recipients browse
 * into subfolders and open anything inside — and the ask was to mirror that.
 *
 * **This widens non-negotiable #5**, which said "one note at a time, by an
 * owner, through a link they mint and can revoke, is the single exception".
 * That sentence is edited in the same change rather than worked around; see
 * `docs/decisions/privacy-and-sharing.md`. What is NOT widened is what `team`
 * means, what `Scope` is, or what any tier says — this is a share row reaching
 * further, exactly as the unlisted note link was a row and never a tier.
 *
 * ## The one place we are deliberately stricter than Drive
 *
 * Drive's model is **inherit unless restricted**: everything under a shared
 * folder is shared by virtue of being under it. Ours is the opposite and it
 * costs nothing to keep — every path is re-derived through the live privacy
 * engine at `team` scope on every read, so a `private` note inside a shared
 * folder is absent, and so is a subfolder held back by name. Nothing is swept
 * in by inheritance that the manifest did not already publish to the
 * workspace.
 *
 * That makes the link's reach a *narrowing* of what the folder already says,
 * never a widening of it, which is the property every test below is about.
 *
 * ## Why the traversal bound is a prefix and not a link graph
 *
 * A note link has `SHARE_TRAVERSAL_DEPTH = 1`: the entry note's own links and
 * nothing further. A folder has no such natural edge, and the honest bound is
 * the folder itself — a reader may reach what is under it and nothing else.
 * So the escape cases are the interesting ones and they are tested first:
 * a sibling folder, a parent, a dot-segment climb, and a path that merely
 * shares a prefix STRING with the shared folder (`1-projects/transition-old`
 * against `1-projects/transition`) without being inside it.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const SHARED = "1-projects/transition";
const INSIDE = "1-projects/transition/overview.md";
const DEEP = "1-projects/transition/notes/deep.md";
const HELD_BACK = "1-projects/transition/salaries.md";
const HELD_MARKER = "zzq-held-back-marker-8e12-never-shared";
/**
 * The prefix trap. `1-projects/transition-old` starts with the shared folder's
 * path as a STRING and is not inside it. A bound written as `startsWith(folder)`
 * hands it over; one written as `startsWith(folder + "/")` does not.
 */
const PREFIX_TWIN = "1-projects/transition-old/leak.md";
const TWIN_MARKER = "zzq-prefix-twin-marker-5b73-never-shared";
const SIBLING = "1-projects/other/plan.md";
const OUTSIDE = "2-areas/salaries.md";
const OUTSIDE_MARKER = "zzq-outside-body-marker-9f04-never-shared";

function errorShape(error: unknown): string {
  return JSON.stringify((error as { data?: unknown }).data ?? null);
}

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  member: Id<"users">;
  stranger: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

async function fixture(): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const member = await createUser(t, "member@example.invalid");
  const stranger = await createUser(t, "stranger@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "atlas");
  await addMember(t, workspaceId, member, "member", owner);
  await createWorkspace(t, stranger, "elsewhere");

  const backend = memoryS3(FAKE_STORAGE.bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  backend.seed(INSIDE, "# Overview\n\nThe plan.\n");
  backend.seed(DEEP, "# Deep\n\nA note in a subfolder.\n");
  backend.seed(HELD_BACK, `# Salaries\n\n${HELD_MARKER}\n`);
  backend.seed(PREFIX_TWIN, `# Old\n\n${TWIN_MARKER}\n`);
  backend.seed(SIBLING, "# Other\n");
  backend.seed(OUTSIDE, `# Salaries\n\n${OUTSIDE_MARKER}\n`);
  vi.stubGlobal("fetch", backend.fetchImpl);

  const encryptedSecretAccessKey = await encryptSecret(
    FAKE_STORAGE.secretAccessKey,
    requireKeyset(),
    { workspaceId },
  );
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  // `1-projects` team-visible, and `transition-old` too, so the prefix twin is
  // refused by the BOUND rather than by happening to be private — which is the
  // only way that test means anything.
  for (const path of ["1-projects"]) {
    await asUser(t, owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId,
      path,
      visibility: "team",
    });
  }
  // One note inside the shared folder held back by name, to prove the engine
  // still decides rather than the folder.
  await asUser(t, owner).action(api.functions.files.setNoteVisibility, {
    workspaceId,
    path: HELD_BACK,
    visibility: "private",
  });

  return { t, owner, member, stranger, workspaceId, backend };
}

/** Mint a folder link as the owner. */
async function link(f: Fixture, path: string = SHARED): Promise<string> {
  const made = await asUser(f.t, f.owner).action(api.functions.shares.createLinkShare, {
    workspaceId: f.workspaceId,
    path,
    kind: "folder",
  });
  return made.token;
}

/** Read through a link with no session at all — the unlisted reader. */
async function anon(f: Fixture, token: string, path?: string) {
  return await f.t.action(api.functions.shares.readSharedNote, { token, path });
}

/* -------------------------------------------------------------------------- */
/*                       1. the subtree is reachable                          */
/* -------------------------------------------------------------------------- */

describe("a folder link reaches the whole subtree", () => {
  test("the folder itself lists what is inside it", async () => {
    const f = await fixture();
    const opened = await anon(f, await link(f));
    expect(opened.entryPath).toBe(SHARED);
    expect(opened.entries.map((entry) => entry.path)).toContain(INSIDE);
  });

  test("a note directly inside opens", async () => {
    const f = await fixture();
    const token = await link(f);
    const note = await anon(f, token, INSIDE);
    expect(note.text).toContain("The plan.");
  });

  /** The Drive behaviour the owner asked for: subfolders are enterable. */
  test("a note in a subfolder opens too, which is what `whole subtree` means", async () => {
    const f = await fixture();
    const token = await link(f);
    const note = await anon(f, token, DEEP);
    expect(note.text).toContain("A note in a subfolder");
  });

  test("the subfolder is listed as a folder rather than hidden", async () => {
    const f = await fixture();
    const opened = await anon(f, await link(f));
    const folders = opened.entries.filter((entry) => entry.kind === "folder");
    expect(folders.map((entry) => entry.path)).toContain("1-projects/transition/notes");
  });
});

/* -------------------------------------------------------------------------- */
/*              2. and never further, which is the whole boundary             */
/* -------------------------------------------------------------------------- */

/**
 * THE ATTACK: READ SOMETHING THE FOLDER DOES NOT CONTAIN.
 *
 * Every refusal here must be byte-identical to every other, and to a token
 * nobody minted — a holder who could tell them apart would learn which paths
 * exist in somebody else's bucket.
 */
describe("a folder link reaches nothing outside the folder", () => {
  test("a sibling folder's note is refused", async () => {
    const f = await fixture();
    const token = await link(f);
    const refused = await captureError(() => anon(f, token, SIBLING));
    expect(errorCode(refused)).toBe("NOT_AUTHENTICATED");
  });

  test("the parent folder is refused", async () => {
    const f = await fixture();
    const token = await link(f);
    const refused = await captureError(() => anon(f, token, "1-projects"));
    expect(errorCode(refused)).toBe("NOT_AUTHENTICATED");
  });

  /**
   * The prefix trap, and the reason this test is worth more than the three
   * above put together: `1-projects/transition-old` starts with the shared
   * folder's path as a string and is not inside it. `startsWith(folder)` hands
   * it over; `startsWith(folder + "/")` does not. It is team-visible, so the
   * refusal can only come from the bound.
   */
  test("a folder whose name merely starts with the shared one is refused", async () => {
    const f = await fixture();
    const token = await link(f);
    const refused = await captureError(() => anon(f, token, PREFIX_TWIN));
    expect(errorCode(refused)).toBe("NOT_AUTHENTICATED");
    expect(errorShape(refused)).not.toContain(TWIN_MARKER);
  });

  test("a dot-segment climb out of the folder is refused", async () => {
    const f = await fixture();
    const token = await link(f);
    for (const path of [
      `${SHARED}/../other/plan.md`,
      `${SHARED}/../../2-areas/salaries.md`,
      `${SHARED}/./../other/plan.md`,
    ]) {
      const refused = await captureError(() => anon(f, token, path));
      expect(errorCode(refused), path).toBe("NOT_AUTHENTICATED");
    }
  });

  test("a note in another folder entirely is refused, body and all", async () => {
    const f = await fixture();
    const token = await link(f);
    const refused = await captureError(() => anon(f, token, OUTSIDE));
    expect(errorShape(refused)).not.toContain(OUTSIDE_MARKER);
  });

  test("every refusal is the same refusal", async () => {
    const f = await fixture();
    const token = await link(f);
    const shapes = new Set<string>();
    for (const path of [SIBLING, PREFIX_TWIN, OUTSIDE, "1-projects", `${SHARED}/nope.md`]) {
      shapes.add(errorShape(await captureError(() => anon(f, token, path))));
    }
    // And a token nobody ever minted looks the same.
    shapes.add(
      errorShape(
        await captureError(() => anon(f, "a".repeat(64), INSIDE)),
      ),
    );
    expect(shapes.size).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*            3. the privacy engine still decides, not the folder             */
/* -------------------------------------------------------------------------- */

/**
 * The half that makes this stricter than Drive. Drive shares by inheritance;
 * a folder link here publishes only what the manifest already published to the
 * workspace, re-derived live on every read.
 */
describe("a note held back by name is absent from a shared folder", () => {
  test("it is not listed", async () => {
    const f = await fixture();
    const opened = await anon(f, await link(f));
    expect(opened.entries.map((entry) => entry.path)).not.toContain(HELD_BACK);
  });

  test("it cannot be opened by naming it", async () => {
    const f = await fixture();
    const token = await link(f);
    const refused = await captureError(() => anon(f, token, HELD_BACK));
    expect(errorCode(refused)).toBe("NOT_AUTHENTICATED");
    expect(errorShape(refused)).not.toContain(HELD_MARKER);
  });

  /**
   * Re-derived live, never snapshotted at mint time. A note made private after
   * the link was pasted is exactly the case a stored listing would miss.
   */
  test("a note made private after the link was minted stops resolving", async () => {
    const f = await fixture();
    const token = await link(f);
    expect((await anon(f, token, INSIDE)).text).toContain("The plan.");

    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: INSIDE,
      visibility: "private",
    });

    const refused = await captureError(() => anon(f, token, INSIDE));
    expect(errorCode(refused)).toBe("NOT_AUTHENTICATED");
    const opened = await anon(f, token);
    expect(opened.entries.map((entry) => entry.path)).not.toContain(INSIDE);
  });

  /**
   * A link reader holds no granted names — they are not a member of anything —
   * so a folder or note pointed at a group is absent through a link exactly as
   * a private one is. Worth pinning: `readThroughShare` reads at `team` scope
   * with no names, and a later change that handed it the OWNER's names would
   * publish every group note in the subtree.
   */
  test("a note named to a group is absent, because a link holds no names", async () => {
    const f = await fixture();
    const group = await asUser(f.t, f.owner).mutation(api.functions.groups.createGroup, {
      workspaceId: f.workspaceId,
      label: "leads",
    });
    await asUser(f.t, f.owner).action(api.functions.files.setNoteGroup, {
      workspaceId: f.workspaceId,
      path: DEEP,
      group: group.name,
    });

    const token = await link(f);
    const refused = await captureError(() => anon(f, token, DEEP));
    expect(errorCode(refused)).toBe("NOT_AUTHENTICATED");
    const opened = await anon(f, token);
    expect(opened.entries.map((entry) => entry.path)).not.toContain(DEEP);
  });
});

/* -------------------------------------------------------------------------- */
/*                     4. plumbing is never a folder's content                */
/* -------------------------------------------------------------------------- */

describe("a folder link never exposes plumbing", () => {
  test("privacy.md is not reachable through a root-adjacent link", async () => {
    const f = await fixture();
    const token = await link(f);
    const refused = await captureError(() => anon(f, token, PRIVACY_KEY));
    expect(errorCode(refused)).toBe("NOT_AUTHENTICATED");
  });

  test("a dot-prefixed path inside the folder is neither listed nor read", async () => {
    const f = await fixture();
    f.backend.seed(`${SHARED}/.history/overview.md.old.md`, "# Old\n");
    const token = await link(f);
    const opened = await anon(f, token);
    expect(JSON.stringify(opened.entries)).not.toContain(".history");
    const refused = await captureError(() =>
      anon(f, token, `${SHARED}/.history/overview.md.old.md`),
    );
    expect(errorCode(refused)).toBe("NOT_AUTHENTICATED");
  });
});

/* -------------------------------------------------------------------------- */
/*                       5. revocation, and the owner's gate                  */
/* -------------------------------------------------------------------------- */

describe("a folder link is revocable and owner-only", () => {
  test("revoking closes the whole subtree at once", async () => {
    const f = await fixture();
    const token = await link(f);
    const shares = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    const row = shares.find((share) => share.entryPath === SHARED);
    expect(row).toBeDefined();
    await asUser(f.t, f.owner).mutation(api.functions.shares.revokeShare, {
      shareId: row!.shareId as Id<"noteShares">,
    });

    for (const path of [undefined, INSIDE, DEEP]) {
      const refused = await captureError(() => anon(f, token, path));
      expect(errorCode(refused)).toBe("NOT_AUTHENTICATED");
    }
  });

  test("a member cannot mint one", async () => {
    const f = await fixture();
    const refused = await captureError(() =>
      asUser(f.t, f.member).action(api.functions.shares.createLinkShare, {
        workspaceId: f.workspaceId,
        path: SHARED,
      }),
    );
    expect(refused).toBeDefined();
  });

  test("making the folder private closes every link into it", async () => {
    const f = await fixture();
    const token = await link(f);
    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: SHARED,
      visibility: "private",
    });
    const refused = await captureError(() => anon(f, token, INSIDE));
    expect(errorCode(refused)).toBe("NOT_AUTHENTICATED");
  });
});
