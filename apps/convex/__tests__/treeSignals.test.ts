/**
 * WHEN A CONSOLE IS TOLD ITS TREE IS STALE, AND WHO IS TOLD.
 *
 * A create, move, delete or visibility change in a context moves a timestamp
 * the console subscribes to, and the console re-lists. The timestamp is kept
 * per audience because a timestamp alone is a disclosure: served to somebody
 * who cannot see what changed, it dates a private note's creation. Each rule
 * below fails when it is removed (sabotage-checked while writing):
 *
 *  - **per audience** — stamping one row for everybody fails "a private note
 *    moves the owner's hint and not a member's".
 *  - **before as well as after** — computing audiences only after the change
 *    fails "making a shared note private tells the member it went".
 *  - **only tree changes** — stamping on every save fails "an edit to an
 *    existing note moves nobody's hint".
 *  - **folders count for what is beneath them** — `treeAudiences` without the
 *    nested-rule scan fails "a folder reaches every audience that can see
 *    something beneath it".
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY, type PrivacyRule, type Visibility } from "../functions/lib/privacy";
import { DELETE_CONFIRMATION } from "../functions/lib/fileOps";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { audiencesOf, treeAudiences } from "../functions/lib/treeAudiences";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  type TestConvex,
  addMember,
  asUser,
  createUser,
  createWorkspace,
  setupTest,
} from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/* -------------------------------------------------------------------------- */
/*                                the audiences                               */
/* -------------------------------------------------------------------------- */

describe("treeAudiences", () => {
  const rules: PrivacyRule[] = [
    { prefix: "1-projects", vis: "team" },
    { prefix: "2-areas", vis: "private" },
    { prefix: "2-areas/leads", vis: "@supa-leads" as Visibility },
  ];
  const overrides = new Map<string, Visibility>([
    ["1-projects/pay.md", "private"],
    ["2-areas/shared.md", "team"],
  ]);

  test("a shared note reaches the owner and the team", () => {
    expect(treeAudiences(["1-projects/plan.md"], rules, overrides)).toEqual(["private", "team"]);
  });

  test("a note held back reaches the owner alone", () => {
    expect(treeAudiences(["1-projects/pay.md"], rules, overrides)).toEqual(["private"]);
    expect(treeAudiences(["2-areas/health.md"], rules, overrides)).toEqual(["private"]);
  });

  test("a note pointed at a group reaches that group, not the team", () => {
    expect(treeAudiences(["2-areas/leads/brief.md"], rules, overrides)).toEqual([
      "@supa-leads",
      "private",
    ]);
  });

  test("a folder reaches every audience that can see something beneath it", () => {
    expect(treeAudiences(["2-areas"], rules, overrides)).toEqual(["@supa-leads", "private", "team"]);
  });

  test("a move reaches both sides' audiences", () => {
    expect(treeAudiences(["2-areas/health.md", "1-projects/health.md"], rules, overrides)).toEqual([
      "private",
      "team",
    ]);
  });

  test("plumbing and the root reach nobody", () => {
    expect(treeAudiences([".context/audit/x.json", PRIVACY_KEY, ""], rules, overrides)).toEqual([]);
  });

  test("a reader's audiences come from their clearance", () => {
    expect(audiencesOf("private", ["supa-leads"])).toEqual(["private"]);
    expect(audiencesOf("team", ["supa-leads"])).toEqual(["team", "@supa-leads"]);
  });
});

/* -------------------------------------------------------------------------- */
/*                          through the real actions                          */
/* -------------------------------------------------------------------------- */

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  member: Id<"users">;
  outsider: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

async function fixture(): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const member = await createUser(t, "member@example.invalid");
  const outsider = await createUser(t, "outsider@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  await addMember(t, workspaceId, member, "member", owner);

  const backend = memoryS3(FAKE_STORAGE.bucket);
  backend.seed(
    PRIVACY_KEY,
    renderPrivacyManifest("para").replace("1-projects: private", "1-projects: team"),
  );
  backend.seed("index.md", "# Context\n");
  backend.seed("1-projects/plan.md", "# Plan\n");
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
      capabilities: {
        conditionalWrite: true,
        conditionalCreate: true,
        conditionalDelete: true,
      },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return { t, owner, member, outsider, workspaceId, backend };
}

async function hint(f: Fixture, who: Id<"users">): Promise<number | null> {
  return await asUser(f.t, who).query(api.functions.treeSignals.treeSignal, {
    workspaceId: f.workspaceId,
  });
}

/** Let the clock move, so a new stamp is distinguishable from the last. */
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("the console's writes move the right hints", () => {
  test("a shared note's creation moves the owner's hint and the member's", async () => {
    const f = await fixture();
    expect(await hint(f, f.member)).toBeNull();
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/launch.md",
      text: "# Launch\n",
    });
    expect(await hint(f, f.member)).not.toBeNull();
    expect(await hint(f, f.owner)).not.toBeNull();
  });

  test("a private note moves the owner's hint and not a member's", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "2-areas/health.md",
      text: "# Health\n",
    });
    expect(await hint(f, f.owner)).not.toBeNull();
    expect(await hint(f, f.member)).toBeNull();
    // Nor is the difference readable in the rows a member could be served.
    const rows = await f.t.run((ctx) => ctx.db.query("treeSignals").collect());
    expect(rows.map((row) => row.audience)).toEqual(["private"]);
  });

  test("an edit to an existing note moves nobody's hint", async () => {
    const f = await fixture();
    const read = await asUser(f.t, f.owner).action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/plan.md",
    });
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/plan.md",
      text: "# Plan\n\nMore.\n",
      expectedEtag: read.etag,
    });
    expect(await hint(f, f.owner)).toBeNull();
    expect(await hint(f, f.member)).toBeNull();
  });

  test("making a shared note private tells the member it went", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects/plan.md",
      visibility: "private",
    });
    expect(await hint(f, f.member)).not.toBeNull();
  });

  test("a move out of a shared folder tells the member, and a later one moves the hint on", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.createDirectory, {
      workspaceId: f.workspaceId,
      path: "1-projects/later",
    });
    const first = await hint(f, f.member);
    expect(first).not.toBeNull();
    await tick();
    await asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
      workspaceId: f.workspaceId,
      from: "1-projects/plan.md",
      to: "2-areas/plan.md",
    });
    expect(await hint(f, f.member)).toBeGreaterThan(first!);
  });

  /**
   * A DELETE RE-DATES A NOTE THE DELETION ITSELF UNHIDES.
   *
   * `1-projects` is a team folder holding one note kept back by an exact
   * override. `deletePath` calls `forgetPrivacy`, which clears that override —
   * correctly, the note is gone and the exception has nothing left to except.
   * But `announceTreeChange` reads the manifest AFTER the operation, so
   * `effectiveVisibility` for the deleted path now falls back to the folder's
   * `team` default and the team audience is stamped for a note no team caller
   * ever saw.
   *
   * The member's hint moving is the whole disclosure: they re-walk, find
   * nothing of theirs changed, and have dated a private note's deletion —
   * which `treeAudiences` promises in its own words they cannot ("a reader
   * never sees one moved by a change they cannot see").
   */
  test("deleting a note held back by name does not re-date it for the member", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects/plan.md",
      visibility: "private",
    });
    // Narrowing it legitimately told the member the note went; that stamp stands.
    const afterNarrowing = await hint(f, f.member);
    expect(afterNarrowing).not.toBeNull();
    await tick();

    await asUser(f.t, f.owner).action(api.functions.files.deleteEntry, {
      workspaceId: f.workspaceId,
      path: "1-projects/plan.md",
      confirmation: DELETE_CONFIRMATION,
    });

    expect(await hint(f, f.member)).toBe(afterNarrowing);
    // And the owner, who could see it, is told.
    expect(await hint(f, f.owner)).toBeGreaterThan(afterNarrowing!);
  });

  test("moving a note held back by name out of a shared folder tells the member nothing", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects/plan.md",
      visibility: "private",
    });
    const afterNarrowing = await hint(f, f.member);
    expect(afterNarrowing).not.toBeNull();
    await tick();

    // `movedOverrides` carries the exception to the destination, so the source
    // path reads as its folder's `team` default afterwards — the same hole the
    // delete above opens, through a different door.
    await asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
      workspaceId: f.workspaceId,
      from: "1-projects/plan.md",
      to: "2-areas/plan.md",
    });

    expect(await hint(f, f.member)).toBe(afterNarrowing);
    expect(await hint(f, f.owner)).toBeGreaterThan(afterNarrowing!);
  });

  test("a refused operation announces nothing", async () => {
    const f = await fixture();
    await expect(
      asUser(f.t, f.member).action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: "1-projects/sneaky.md",
        text: "# no\n",
      }),
    ).rejects.toThrow();
    expect(await f.t.run((ctx) => ctx.db.query("treeSignals").collect())).toEqual([]);
  });

  test("a non-member is told nothing, the same nothing as a context that never changed", async () => {
    const f = await fixture();
    await f.t.mutation(internal.functions.treeSignals.markTreeChanged, {
      workspaceId: f.workspaceId,
      audiences: ["private", "team"],
    });
    expect(await hint(f, f.member)).not.toBeNull();
    expect(await hint(f, f.outsider)).toBeNull();
  });

  test("the gateway's route moves the audiences it names and ignores anything else", async () => {
    const f = await fixture();
    await f.t.mutation(internal.functions.treeSignals.markTreeChanged, {
      workspaceId: f.workspaceId,
      audiences: ["team", "not an audience", "1-projects/plan.md"],
    });
    const rows = await f.t.run((ctx) => ctx.db.query("treeSignals").collect());
    expect(rows.map((row) => row.audience)).toEqual(["team"]);
    expect(await hint(f, f.member)).not.toBeNull();
  });
});
