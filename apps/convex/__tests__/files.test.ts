/**
 * THE FILE EDITOR, THROUGH THE CONTROL PLANE.
 *
 * `fileOps.test.ts` proves the operations against a bucket. This one proves
 * the two things only the Convex layer can get wrong:
 *
 *  1. **Authorization.** Reading needs `member`; writing needs `editor`. A
 *     non-member gets an error byte-identical to the one for a workspace that
 *     never existed, in the style of `isolation.test.ts` — because an endpoint
 *     that distinguishes them is an oracle for which contexts are real.
 *  2. **Note content does not stay here.** The control plane holds metadata
 *     only (CLAUDE.md non-negotiable #1). Content passes through an action and
 *     is returned; it must appear in no table, no audit row, and no error
 *     message. That is asserted by writing a distinctive marker through every
 *     operation and then sweeping the entire database for it.
 *
 * The whole path is real: the real actions, the real `S3Store` doing real
 * SigV4 against a `fetch` stub speaking S3, the real envelope opened by the
 * real `decryptSecret`. Only the socket is fake.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { DELETE_CONFIRMATION } from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3, type MemoryS3, type MemoryS3Options } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  type TestConvex,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A marker that could only have come from note content.
 *
 * Long, unique, and nothing like a path — so a sweep that finds it has found
 * a leak, not a coincidence.
 */
const SECRET_BODY_MARKER = "zzq-note-body-marker-9f13c4d2-never-persist";

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  editor: Id<"users">;
  reader: Id<"users">;
  stranger: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

/**
 * A workspace with an owner, an editor, a read-only member, a stranger, and a
 * bucket behind it holding a small PARA context.
 *
 * The binding row is inserted directly rather than through `bindStorage`, for
 * the reason `provisioning.test.ts` documents: the public flow also *schedules*
 * a verification, and that scheduled probe would race the action under test.
 * The envelope is produced by the real `encryptSecret`, so the decrypt path
 * exercised here is the real one.
 */
async function fixture(
  options: MemoryS3Options & { conditionalWrite?: boolean } = {},
): Promise<Fixture> {
  const { conditionalWrite = true, ...bucketOptions } = options;
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const editor = await createUser(t, "editor@example.invalid");
  const reader = await createUser(t, "reader@example.invalid");
  const stranger = await createUser(t, "stranger@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "atlas");
  await addMember(t, workspaceId, editor, "editor", owner);
  await addMember(t, workspaceId, reader, "member", owner);
  // The stranger is a real, authenticated user with a context of her own.
  await createWorkspace(t, stranger, "elsewhere");

  const backend = memoryS3(FAKE_STORAGE.bucket, bucketOptions);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  backend.seed("1-projects/README.md", "# Projects\n");
  backend.seed("1-projects/shared.md", "# Shared\n");
  backend.seed("2-areas/README.md", "# Areas\n");
  backend.seed("2-areas/private-note.md", `# Private\n\n${SECRET_BODY_MARKER}\n`);
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
      capabilities: { conditionalWrite },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  return { t, owner, editor, reader, stranger, workspaceId, backend };
}

/** Share `1-projects`, so a `team`-scoped caller has something to see. */
async function share(f: Fixture): Promise<void> {
  await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId: f.workspaceId,
    path: "1-projects",
    visibility: "team",
  });
}

function errorShape(error: unknown): string {
  return JSON.stringify((error as { data?: unknown }).data ?? null);
}

/**
 * A workspace id that refers to nothing, produced by creating and deleting a
 * row so it is indistinguishable in shape from a live one.
 */
async function danglingWorkspaceId(t: TestConvex): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const id = await ctx.db.insert("workspaces", {
      slug: "temporary-placeholder",
      displayName: "Temporary",
      createdBy: (await ctx.db.insert("users", { createdAt: Date.now() })) as Id<"users">,
      kind: "personal",
      structureTemplate: "para",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.delete(id);
    return id;
  });
}

/* -------------------------------------------------------------------------- */
/*                              the happy paths                               */
/* -------------------------------------------------------------------------- */

describe("an owner can edit their context", () => {
  test("lists a folder", async () => {
    const f = await fixture();
    const listing = await asUser(f.t, f.owner).action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "",
    });
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      "1-projects",
      "2-areas",
      "index.md",
      "privacy.md",
    ]);
  });

  test("reads a note and gets an etag to save against", async () => {
    const f = await fixture();
    const file = await asUser(f.t, f.owner).action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
    });
    expect(file.text).toContain("# Shared");
    expect(file.etag).toBeTruthy();
  });

  test("creates, renames, duplicates and archives", async () => {
    const f = await fixture();
    const as = asUser(f.t, f.owner);

    await as.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/new.md",
      text: "# New\n",
    });
    await as.action(api.functions.files.moveEntry, {
      workspaceId: f.workspaceId,
      from: "1-projects/new.md",
      to: "1-projects/renamed.md",
    });
    const duplicated = await as.action(api.functions.files.duplicateEntry, {
      workspaceId: f.workspaceId,
      path: "1-projects/renamed.md",
    });
    expect(duplicated.to).toBe("1-projects/renamed copy.md");

    const archived = await as.action(api.functions.files.archiveEntry, {
      workspaceId: f.workspaceId,
      path: "1-projects/renamed.md",
    });
    expect(archived.to).toMatch(/^4-archive\//);
    expect(f.backend.snapshot()[archived.to]).toBe("# New\n");
  });

  test("creates a folder", async () => {
    const f = await fixture();
    const created = await asUser(f.t, f.owner).action(
      api.functions.files.createDirectory,
      { workspaceId: f.workspaceId, path: "1-projects/plans" },
    );
    expect(f.backend.snapshot()[created.readme]).toContain("# plans");
  });

  test("pastes a copy at an explicit destination", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.copyEntry, {
      workspaceId: f.workspaceId,
      from: "1-projects/shared.md",
      to: "2-areas/shared.md",
    });
    expect(f.backend.snapshot()["2-areas/shared.md"]).toContain("# Shared");
  });

  test("changes a note's visibility, and the manifest the gateway reads follows", async () => {
    const f = await fixture();
    await share(f);
    const result = await asUser(f.t, f.owner).action(
      api.functions.files.setNoteVisibility,
      {
        workspaceId: f.workspaceId,
        path: "1-projects/shared.md",
        visibility: "private",
      },
    );
    expect(result.exception).toBe(true);
    expect(f.backend.snapshot()[PRIVACY_KEY]).toContain("1-projects/shared.md: private");
  });
});

/* -------------------------------------------------------------------------- */
/*                                   roles                                    */
/* -------------------------------------------------------------------------- */

describe("read access and write access are different grants", () => {
  test("a read-only member may list and read what is shared", async () => {
    const f = await fixture();
    await share(f);
    const listing = await asUser(f.t, f.reader).action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "1-projects",
    });
    expect(listing.entries.map((entry) => entry.name)).toContain("shared.md");
  });

  test("a read-only member cannot write", async () => {
    const f = await fixture();
    await share(f);
    const error = await captureError(() =>
      asUser(f.t, f.reader).action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: "1-projects/shared.md",
        text: "# Vandalised\n",
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect(f.backend.snapshot()["1-projects/shared.md"]).toBe("# Shared\n");
  });

  /**
   * The enumeration IS the guard, and it went stale.
   *
   * Every write action's clearance lives in one `minimum:` line in
   * `functions/files.ts`, and this list is the only thing holding those lines.
   * Mutating each of the ten in turn — `editor` to `member`, `owner` to
   * `editor` — found **four that produced zero failures across all 1123
   * checks**: `copyEntry`, `duplicateEntry`, `archiveEntry` and `resetPrivacy`.
   * All four were added after this list was written and never added to it.
   *
   * **They are not the same kind of hole, and the difference is measured rather
   * than assumed.** With its bar lowered to `member`:
   *
   *  - `copyEntry` and `duplicateEntry` **resolve**, and the key lands
   *    (`1-projects/copied.md`, `1-projects/shared copy.md`). The role gate is
   *    the only thing between a read tier and a write.
   *  - `archiveEntry` is refused `ARCHIVE_UNAVAILABLE` — by `archivePath`'s own
   *    scope gate, because `4-archive` is private by default and a team-scope
   *    caller cannot write into a folder they cannot see. Its role gate is
   *    load-bearing only where the owner has shared `4-archive`, which is why
   *    this test now shares it: with that done, the archive key lands too.
   *  - `resetPrivacy` is refused `PRIVACY_MANIFEST_READ_ONLY` by the module —
   *    the belt-and-braces CLAUDE.md states deliberately, "checked at the action
   *    (`minimum: "owner"`) and again in the module a test can drive without a
   *    session". The braces held it; only the belt was unheld.
   *
   * An earlier version of this comment said the first three were "the only
   * thing standing between a read-only member and a write". That was true of
   * two of them. Getting it wrong here is worse than elsewhere, because the
   * distinction it missed is the one the same comment draws for `resetPrivacy`
   * two paragraphs down.
   */
  test("a read-only member cannot delete, move, or change visibility either", async () => {
    const f = await fixture();
    await share(f);
    // `4-archive` shared too, so `archiveEntry`'s destination is reachable at
    // team scope and its role gate becomes the only remaining bar. Without it
    // the archive is refused by `archivePath` whatever its clearance says, and
    // both the third clause of the assertion below and the claim above would be
    // untestable. Verified by lowering all three bars: the three keys land.
    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "4-archive",
      visibility: "team",
    });
    const as = asUser(f.t, f.reader);
    for (const call of [
      () =>
        as.action(api.functions.files.deleteEntry, {
          workspaceId: f.workspaceId,
          path: "1-projects/shared.md",
          confirmation: DELETE_CONFIRMATION,
        }),
      () =>
        as.action(api.functions.files.moveEntry, {
          workspaceId: f.workspaceId,
          from: "1-projects/shared.md",
          to: "1-projects/moved.md",
        }),
      () =>
        as.action(api.functions.files.setNoteVisibility, {
          workspaceId: f.workspaceId,
          path: "1-projects/shared.md",
          visibility: "private",
        }),
      () =>
        as.action(api.functions.files.createDirectory, {
          workspaceId: f.workspaceId,
          path: "1-projects/new-folder",
        }),
      () =>
        as.action(api.functions.files.copyEntry, {
          workspaceId: f.workspaceId,
          from: "1-projects/shared.md",
          to: "1-projects/copied.md",
        }),
      () =>
        as.action(api.functions.files.duplicateEntry, {
          workspaceId: f.workspaceId,
          path: "1-projects/shared.md",
        }),
      () =>
        as.action(api.functions.files.archiveEntry, {
          workspaceId: f.workspaceId,
          path: "1-projects/shared.md",
        }),
    ]) {
      expect(errorCode(await captureError(call))).toBe("INSUFFICIENT_ROLE");
    }
    expect(f.backend.snapshot()["1-projects/shared.md"]).toBe("# Shared\n");
    // Nothing arrived anywhere either — a refusal that still wrote the
    // destination would pass every assertion above. Every clause can fire:
    // with the three role gates lowered this filter returns
    // `["1-projects/copied.md", "1-projects/shared copy.md",
    //   "4-archive/<stamp>/1-projects/shared.md"]`.
    expect(
      Object.keys(f.backend.snapshot()).filter(
        (key) =>
          key.includes("copied") || key.includes(" copy") || key.startsWith("4-archive/2"),
      ),
    ).toEqual([]);
  });

  test("an editor cannot rewrite the access map — the action's own bar, not the module's", async () => {
    // `resetPrivacy` is guarded twice on purpose: `minimum: "owner"` at the
    // action, and `scope !== "private"` inside `resetPrivacyManifest`. Dropping
    // the action's bar to `editor` failed nothing, because the module caught it
    // — so this asserts the code the ACTION produces, which is the one the
    // module never emits.
    const f = await fixture();
    await share(f);
    await f.t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .collect();
      const reader = membership.find((row) => row.userId === f.reader);
      if (reader !== undefined) await ctx.db.patch(reader._id, { role: "editor" });
    });

    const error = await captureError(() =>
      asUser(f.t, f.reader).action(api.functions.files.resetPrivacy, {
        workspaceId: f.workspaceId,
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
  });

  test("an editor may write", async () => {
    const f = await fixture();
    await share(f);
    await asUser(f.t, f.editor).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/from-editor.md",
      text: "# Editor\n",
    });
    expect(f.backend.snapshot()["1-projects/from-editor.md"]).toBe("# Editor\n");
  });
});

/* -------------------------------------------------------------------------- */
/*                            visibility as a boundary                        */
/* -------------------------------------------------------------------------- */

describe("a team-scoped caller cannot read, list, or infer a private note", () => {
  /**
   * `owner` gets `private` scope; everyone else in the workspace gets `team`.
   * Being able to write is a separate grant from being able to see what the
   * owner marked private — see the module comment in `functions/files.ts`.
   */
  test("a member does not see a private folder at all", async () => {
    const f = await fixture();
    await share(f);
    const listing = await asUser(f.t, f.reader).action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "",
    });
    expect(listing.entries.map((entry) => entry.name)).toEqual(["1-projects"]);
  });

  test("nor privacy.md, which would name every private folder", async () => {
    const f = await fixture();
    await share(f);
    const listing = await asUser(f.t, f.reader).action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "",
    });
    expect(listing.entries.map((entry) => entry.name)).not.toContain(PRIVACY_KEY);
  });

  test("reading a private note fails byte-identically to reading one that never existed", async () => {
    const f = await fixture();
    await share(f);
    const as = asUser(f.t, f.reader);

    const hidden = await captureError(() =>
      as.action(api.functions.files.readNote, {
        workspaceId: f.workspaceId,
        path: "2-areas/private-note.md",
      }),
    );
    const absent = await captureError(() =>
      as.action(api.functions.files.readNote, {
        workspaceId: f.workspaceId,
        path: "2-areas/no-such-note.md",
      }),
    );
    expect(errorShape(hidden)).toBe(errorShape(absent));
    expect(errorCode(hidden)).toBe("FILE_NOT_FOUND");
  });

  /**
   * End to end, and the collapse is now an ANSWER rather than a refusal.
   *
   * It used to be a shared `FILE_NOT_FOUND`, which read as safe and was the
   * leak: a name that does not exist inherits its parent's default, so under a
   * team-visible parent it was visible and returned an empty listing while a
   * private one refused. Two answers, and the difference was the withheld fact.
   * Both give the empty listing now — including inside a folder the caller can
   * see, which is where the old shape came apart.
   */
  test("listing a private folder is byte-identical to listing one that never existed", async () => {
    const f = await fixture();
    await share(f);
    const as = asUser(f.t, f.reader);
    const hidden = await as.action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "2-areas",
    });
    const absent = await as.action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "9-imaginary",
    });
    // `path` echoes the request, so it is the one field allowed to differ.
    expect(JSON.stringify({ ...hidden, path: null })).toBe(
      JSON.stringify({ ...absent, path: null }),
    );
  });

  /**
   * And inside a folder the caller CAN see, which is where the old shape came
   * apart. At the root both legs were refused because the root default is
   * private; one level in, an absent name inherits `team`, is visible, and used
   * to return an empty listing while a private sibling refused.
   *
   * The private subfolder is built here rather than in `share`, because a
   * fixture without one makes both legs absent and the comparison vacuous —
   * which is how the first version of this test passed.
   */
  test("and the same holds inside a folder the caller can see", async () => {
    const f = await fixture();
    await share(f);
    const owner = asUser(f.t, f.owner);
    await owner.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/secret-client/brief.md",
      text: "# Brief\n",
    });
    await owner.action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects/secret-client",
      visibility: "private",
    });

    // The owner sees it, so the collapse below is about scope rather than the
    // folder having stopped existing.
    expect(
      (
        await owner.action(api.functions.files.listFiles, {
          workspaceId: f.workspaceId,
          path: "1-projects/secret-client",
        })
      ).entries.map((e: { name: string }) => e.name),
    ).toEqual(["brief.md"]);

    const as = asUser(f.t, f.reader);
    const hidden = await as.action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "1-projects/secret-client",
    });
    const absent = await as.action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "1-projects/never-existed",
    });
    expect(JSON.stringify({ ...hidden, path: null })).toBe(
      JSON.stringify({ ...absent, path: null }),
    );
  });

  test("an editor writing into a folder they cannot see is refused, and refused the same way", async () => {
    const f = await fixture();
    await share(f);
    const as = asUser(f.t, f.editor);
    const hidden = await captureError(() =>
      as.action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: "2-areas/sneaky.md",
        text: "# Sneaky\n",
      }),
    );
    expect(errorCode(hidden)).toBe("FILE_NOT_FOUND");
    expect(f.backend.snapshot()["2-areas/sneaky.md"]).toBeUndefined();
  });

  test("the owner still sees everything", async () => {
    const f = await fixture();
    await share(f);
    const listing = await asUser(f.t, f.owner).action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "2-areas",
    });
    expect(listing.entries.map((entry) => entry.name)).toContain("private-note.md");
  });
});

/* -------------------------------------------------------------------------- */
/*                              tenant isolation                              */
/* -------------------------------------------------------------------------- */

describe("a stranger cannot reach another workspace's files", () => {
  test("every file endpoint answers exactly as it does for a workspace that never existed", async () => {
    const f = await fixture();
    const dangling = await danglingWorkspaceId(f.t);
    const as = asUser(f.t, f.stranger);

    const calls: Array<(workspaceId: Id<"workspaces">) => Promise<unknown>> = [
      (workspaceId) => as.action(api.functions.files.listFiles, { workspaceId, path: "" }),
      (workspaceId) =>
        as.action(api.functions.files.readNote, { workspaceId, path: "1-projects/shared.md" }),
      (workspaceId) =>
        as.action(api.functions.files.writeNote, {
          workspaceId,
          path: "1-projects/x.md",
          text: "x",
        }),
      (workspaceId) =>
        as.action(api.functions.files.moveEntry, { workspaceId, from: "a.md", to: "b.md" }),
      (workspaceId) =>
        as.action(api.functions.files.copyEntry, { workspaceId, from: "a.md", to: "b.md" }),
      (workspaceId) =>
        as.action(api.functions.files.duplicateEntry, { workspaceId, path: "a.md" }),
      (workspaceId) =>
        as.action(api.functions.files.archiveEntry, { workspaceId, path: "a.md" }),
      (workspaceId) =>
        as.action(api.functions.files.createDirectory, { workspaceId, path: "a" }),
      (workspaceId) =>
        as.action(api.functions.files.deleteEntry, {
          workspaceId,
          path: "a.md",
          confirmation: DELETE_CONFIRMATION,
        }),
      (workspaceId) =>
        as.action(api.functions.files.setNoteVisibility, {
          workspaceId,
          path: "a.md",
          visibility: "team",
        }),
      (workspaceId) =>
        as.action(api.functions.files.setDirectoryVisibility, {
          workspaceId,
          path: "a",
          visibility: "team",
        }),
    ];

    for (const call of calls) {
      const theirs = await captureError(() => call(f.workspaceId));
      const nowhere = await captureError(() => call(dangling));
      expect(errorCode(theirs)).toBe("WORKSPACE_NOT_FOUND");
      expect(errorShape(theirs)).toBe(errorShape(nowhere));
    }
  });

  test("and nothing in the other tenant's bucket was touched", async () => {
    const f = await fixture();
    const before = f.backend.snapshot();
    await captureError(() =>
      asUser(f.t, f.stranger).action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: "1-projects/shared.md",
        text: "# Vandalised\n",
      }),
    );
    expect(f.backend.snapshot()).toEqual(before);
  });

  test("a signed-out caller is turned away before anything else happens", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      f.t.action(api.functions.files.listFiles, { workspaceId: f.workspaceId, path: "" }),
    );
    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
  });
});

/* -------------------------------------------------------------------------- */
/*                                  conflicts                                 */
/* -------------------------------------------------------------------------- */

describe("a stale save is a conflict, never a silent overwrite", () => {
  test("the conflict reaches the client with the current etag", async () => {
    const f = await fixture();
    const as = asUser(f.t, f.owner);
    const first = await as.action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
    });
    await as.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: first.path,
      text: "# Theirs\n",
      expectedEtag: first.etag,
    });

    const error = await captureError(() =>
      as.action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: first.path,
        text: "# Mine\n",
        expectedEtag: first.etag,
      }),
    );
    expect(errorCode(error)).toBe("CONFLICT");
    const data = (error as { data: { currentEtag?: string; message: string } }).data;
    expect(data.currentEtag).toBeTruthy();
    expect(data.message).toMatch(/changed somewhere else/);
    expect(f.backend.snapshot()["1-projects/shared.md"]).toBe("# Theirs\n");
  });

  test("a backend that ignores If-Match still reports it, and the write says how it was checked", async () => {
    const f = await fixture({ ignoreIfMatch: true, conditionalWrite: false });
    const as = asUser(f.t, f.owner);
    const first = await as.action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
    });
    const theirs = await as.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: first.path,
      text: "# Theirs\n",
      expectedEtag: first.etag,
    });
    expect(theirs.conflictCheck).toBe("read-compare");

    const error = await captureError(() =>
      as.action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: first.path,
        text: "# Mine\n",
        expectedEtag: first.etag,
      }),
    );
    expect(errorCode(error)).toBe("CONFLICT");
    expect(f.backend.snapshot()["1-projects/shared.md"]).toBe("# Theirs\n");
  });
});

/* -------------------------------------------------------------------------- */
/*                            deleting and archiving                          */
/* -------------------------------------------------------------------------- */

describe("permanent deletion is explicit", () => {
  test("the wrong confirmation changes nothing", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.deleteEntry, {
        workspaceId: f.workspaceId,
        path: "1-projects/shared.md",
        confirmation: "yes",
      }),
    );
    expect(errorCode(error)).toBe("CONFIRMATION_REQUIRED");
    expect(f.backend.snapshot()["1-projects/shared.md"]).toBe("# Shared\n");
  });

  test("the right one deletes, and keeps nothing back", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.deleteEntry, {
      workspaceId: f.workspaceId,
      path: "2-areas/private-note.md",
      confirmation: DELETE_CONFIRMATION,
    });
    const survivors = Object.values(f.backend.snapshot()).filter((body) =>
      body.includes(SECRET_BODY_MARKER),
    );
    expect(survivors).toEqual([]);
  });

  test("archiving is recoverable — the note is still in the bucket", async () => {
    const f = await fixture();
    const archived = await asUser(f.t, f.owner).action(api.functions.files.archiveEntry, {
      workspaceId: f.workspaceId,
      path: "2-areas/private-note.md",
    });
    expect(f.backend.snapshot()[archived.to]).toContain(SECRET_BODY_MARKER);

    await asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
      workspaceId: f.workspaceId,
      from: archived.to,
      to: "2-areas/private-note.md",
    });
    expect(f.backend.snapshot()["2-areas/private-note.md"]).toContain(SECRET_BODY_MARKER);
  });
});

/* -------------------------------------------------------------------------- */
/*                    note content never stays in the control plane           */
/* -------------------------------------------------------------------------- */

describe("note content never lands in the control plane", () => {
  /**
   * The sweep. Every document in every table, serialized, searched for the
   * marker — rather than checking the two tables we happen to think of, which
   * would pass on the day somebody adds a third.
   */
  async function everyStoredDocument(t: TestConvex): Promise<string> {
    return await t.run(async (ctx) => {
      const tables = [
        "names",
        "workspaces",
        "workspaceMembers",
        "storageBindings",
        "rateLimits",
        "oauthClients",
        "oauthGrants",
        "auditEvents",
      ] as const;
      const dump: Record<string, unknown[]> = {};
      for (const table of tables) {
        dump[table] = await ctx.db.query(table).collect();
      }
      return JSON.stringify(dump);
    });
  }

  test("after a full editing session, no table holds a byte of it", async () => {
    const f = await fixture();
    const as = asUser(f.t, f.owner);
    const body = `# Sensitive\n\n${SECRET_BODY_MARKER}\n`;

    await as.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/sensitive.md",
      text: body,
    });
    const read = await as.action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/sensitive.md",
    });
    // It really did come back — otherwise the sweep below proves nothing.
    expect(read.text).toContain(SECRET_BODY_MARKER);

    await as.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: read.path,
      text: `${body}more\n`,
      expectedEtag: read.etag,
    });
    await as.action(api.functions.files.duplicateEntry, {
      workspaceId: f.workspaceId,
      path: "1-projects/sensitive.md",
    });
    await as.action(api.functions.files.moveEntry, {
      workspaceId: f.workspaceId,
      from: "1-projects/sensitive.md",
      to: "1-projects/moved-sensitive.md",
    });
    await as.action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects/moved-sensitive.md",
      visibility: "team",
    });
    await as.action(api.functions.files.archiveEntry, {
      workspaceId: f.workspaceId,
      path: "1-projects/moved-sensitive.md",
    });
    await as.action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "1-projects",
    });

    const dump = await everyStoredDocument(f.t);
    expect(dump).not.toContain(SECRET_BODY_MARKER);
    // The bucket, meanwhile, has it — which is the whole point.
    expect(JSON.stringify(f.backend.snapshot())).toContain(SECRET_BODY_MARKER);
  });

  test("the audit trail records paths and an outcome, and nothing else", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/sensitive.md",
      text: `# Sensitive\n\n${SECRET_BODY_MARKER}\n`,
    });

    const events = await asUser(f.t, f.owner).query(api.functions.audit.listEvents, {
      workspaceId: f.workspaceId,
    });
    const write = events.find((event) => event.action === "file.create")!;
    expect(write).toBeDefined();
    expect(write.paths).toEqual(["1-projects/sensitive.md"]);
    expect(write.actorUserId).toBe(f.owner);
    expect(JSON.stringify(write.details ?? {})).not.toContain(SECRET_BODY_MARKER);
  });

  test("every write operation leaves an audit row naming the acting identity", async () => {
    const f = await fixture();
    const as = asUser(f.t, f.editor);
    await share(f);
    await as.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/a.md",
      text: "# A\n",
    });
    await as.action(api.functions.files.duplicateEntry, {
      workspaceId: f.workspaceId,
      path: "1-projects/a.md",
    });
    await as.action(api.functions.files.deleteEntry, {
      workspaceId: f.workspaceId,
      path: "1-projects/a copy.md",
      confirmation: DELETE_CONFIRMATION,
    });

    const events = await asUser(f.t, f.owner).query(api.functions.audit.listEvents, {
      workspaceId: f.workspaceId,
    });
    const actions = events.map((event) => event.action);
    expect(actions).toContain("file.create");
    expect(actions).toContain("file.duplicate");
    expect(actions).toContain("file.delete");
    for (const event of events.filter((e) => e.action.startsWith("file."))) {
      expect(event.actorUserId).toBe(f.editor);
    }
  });

  /**
   * A failure is the other way content escapes: an error that quotes what you
   * tried to save, stored on a row or shown in a toast, is the same leak with
   * a stack trace attached.
   */
  test("no failure message quotes the content that failed", async () => {
    const f = await fixture();
    const as = asUser(f.t, f.owner);
    const body = `# Sensitive\n\n${SECRET_BODY_MARKER}\n`;

    // A create over something that exists, a conflict, and a refused path —
    // three different failure shapes, all carrying the same body.
    const failures = [
      await captureError(() =>
        as.action(api.functions.files.writeNote, {
          workspaceId: f.workspaceId,
          path: "1-projects/shared.md",
          text: body,
        }),
      ),
      await captureError(() =>
        as.action(api.functions.files.writeNote, {
          workspaceId: f.workspaceId,
          path: PRIVACY_KEY,
          text: body,
        }),
      ),
      await captureError(() =>
        as.action(api.functions.files.writeNote, {
          workspaceId: f.workspaceId,
          path: "1-projects/shared.md",
          text: body,
          expectedEtag: "not-the-real-etag",
        }),
      ),
    ];

    for (const failure of failures) {
      expect(JSON.stringify(failure)).not.toContain(SECRET_BODY_MARKER);
      expect(String((failure as Error).message ?? "")).not.toContain(SECRET_BODY_MARKER);
    }

    const dump = await everyStoredDocument(f.t);
    expect(dump).not.toContain(SECRET_BODY_MARKER);
  });

  /**
   * The other half of the same promise: the bucket credential the barrier
   * opens must not come back out either — not in a result, not in an error.
   */
  test("no bucket credential reaches the caller", async () => {
    const f = await fixture();
    const listing = await asUser(f.t, f.owner).action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "",
    });
    expect(JSON.stringify(listing)).not.toContain(FAKE_STORAGE.secretAccessKey);
    expect(JSON.stringify(listing)).not.toContain(FAKE_STORAGE.accessKeyId);

    const failure = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.readNote, {
        workspaceId: f.workspaceId,
        path: "does-not-exist.md",
      }),
    );
    expect(JSON.stringify(failure)).not.toContain(FAKE_STORAGE.secretAccessKey);
  });

  test("a provider's own error text is not forwarded to the caller", async () => {
    const f = await fixture({
      readOnly: true,
      errorMessage: `signature mismatch for ${FAKE_STORAGE.accessKeyId}`,
    });
    const failure = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: "1-projects/nope.md",
        text: "# Nope\n",
      }),
    );
    expect(errorCode(failure)).toBe("STORAGE_FAILED");
    expect(JSON.stringify(failure)).not.toContain(FAKE_STORAGE.accessKeyId);
  });
});

/* -------------------------------------------------------------------------- */
/*                              no bucket connected                           */
/* -------------------------------------------------------------------------- */

describe("a context with no bucket says so", () => {
  test("listing reports that storage is not connected", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "unbound");
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.files.listFiles, { workspaceId, path: "" }),
    );
    expect(errorCode(error)).toBe("STORAGE_NOT_CONNECTED");
  });
});

describe("visibility is a clearance decision, and clearance belongs to the owner", () => {
  /**
   * The live breach, pinned. Seyi invited a test agent as an editor and
   * watched it flip his private folders to `team` — at which point it could
   * read everything in them. An editor changing visibility is an editor
   * deciding their own clearance; `resetPrivacy` had already written that
   * argument down and gated itself `owner`, while these two said `editor`.
   * The MCP gateway got it right from day one (`scope !== "private"` →
   * refused); the console actions are what this suite now holds to the same
   * rule.
   */
  test("an editor cannot widen a folder to team — the exact live attack", async () => {
    const f = await fixture();
    await share(f);

    const error = await captureError(() =>
      asUser(f.t, f.editor).action(api.functions.files.setDirectoryVisibility, {
        workspaceId: f.workspaceId,
        path: "2-areas",
        visibility: "team",
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");

    // And the private note behind that folder stays unreadable: the attack's
    // payoff, not just its mechanism, is what must be absent.
    const read = await captureError(() =>
      asUser(f.t, f.editor).action(api.functions.files.readNote, {
        workspaceId: f.workspaceId,
        path: "2-areas/shared.md",
      }),
    );
    expect(errorCode(read)).not.toBeNull();
  });

  test("an editor cannot change a note's visibility either — narrowing included", async () => {
    const f = await fixture();
    await share(f);
    // Narrowing is refused too: visibility writes rewrite privacy.md, and an
    // editor hiding a team note from other members is the same authority
    // exercised in the other direction.
    const error = await captureError(() =>
      asUser(f.t, f.editor).action(api.functions.files.setNoteVisibility, {
        workspaceId: f.workspaceId,
        path: "1-projects/shared.md",
        visibility: "private",
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
  });

  test("the owner still can — this is a gate, not a removal", async () => {
    const f = await fixture();
    await share(f);
    const result = await asUser(f.t, f.owner).action(
      api.functions.files.setDirectoryVisibility,
      { workspaceId: f.workspaceId, path: "2-areas", visibility: "team" },
    );
    expect(result.visibility).toBe("team");
  });
});
