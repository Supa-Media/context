/**
 * `activity.md`, through the console.
 *
 * `apps/mcp/test/activity.test.mjs` proves the format and the gateway's half.
 * This proves the half only the control plane can get wrong: that a person
 * editing in the console lands in the same file an AI client writes to, under
 * their own name; that the file stays private whatever the folder it sits in
 * says; and that a member reading it back is served their own view of it
 * rather than the owner's.
 *
 * The whole path is real — the real actions, the real S3 store against a
 * memory backend, the real privacy engine. Only the socket is fake.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `recordActivity`'s `setExactVisibility` call dropped            2 failed
 *   `team_visible` taken from the caller instead of the manifest    1 failed
 *   `readActivity` passing `owner: true` for every scope            1 failed
 *   `markSeen` patching without the forward-only guard              1 failed
 *   `activityAt` served to every member regardless of role           1 failed
 *   `markWorkspaceActivity` moving the team stamp unconditionally    2 failed
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ACTIVITY_PATH, parseFile } from "@context/shared/src/activity.cjs";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
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

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  member: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

async function fixture(): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const member = await createUser(t, "member@example.invalid");
  // Each person's own context, so both have a `@name` the feed can use — the
  // same name the gateway would write for their AI client.
  const workspaceId = await createWorkspace(t, owner, "atlas");
  await createWorkspace(t, member, "morayo");
  await addMember(t, workspaceId, member, "editor", owner);

  const backend = memoryS3(FAKE_STORAGE.bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
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
  return { t, owner, member, workspaceId, backend };
}

/** A note long enough to clear the substance threshold on its own. */
const BODY = `# Week one\n\n${"a".repeat(600)}\n`;

/** What is at a key right now, or undefined. `snapshot()` decodes as text. */
function fileAt(backend: MemoryS3, key: string): string | undefined {
  return backend.snapshot()[key];
}

/**
 * The workspace's activity stamp, or `null` when it has never been set.
 *
 * `t.run` hands its result back through Convex's value encoding, where an
 * absent optional field arrives as `null` rather than `undefined` — so the
 * assertions read `toBeNull()`, and "no stamp" is one value rather than two.
 */
async function stampOf(f: Fixture): Promise<number | null> {
  return await f.t.run(async (ctx) => (await ctx.db.get(f.workspaceId))?.activityAt ?? null);
}

function entriesIn(backend: MemoryS3) {
  const raw = fileAt(backend, ACTIVITY_PATH);
  return raw === undefined ? [] : parseFile(raw);
}

describe("a person editing in the console", () => {
  test("lands in activity.md under their own name, with no client", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects",
      visibility: "team",
    });
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/week-one.md",
      text: BODY,
    });

    // Two lines: sharing the folder is activity too, and it happened first.
    const entries = entriesIn(f.backend);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ kind: "published", paths: ["1-projects"] });
    expect(entries[0]).toMatchObject({
      kind: "added",
      paths: ["1-projects/week-one.md"],
      by: "@atlas",
      // Null, and deliberately: the console is the person's own hand. "@atlas's
      // Context" would be the product claiming to be a third party.
      via: null,
      vis: "team",
    });
  });

  test("is refused to a member, and taken back if somebody publishes it", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/week-one.md",
      text: BODY,
    });

    // Private by inheritance: `privacy.md`'s format requires a private root,
    // so a file at the root of the bucket is private in every manifest that
    // parses at all.
    await expect(
      asUser(f.t, f.member).action(api.functions.files.readNote, {
        workspaceId: f.workspaceId,
        path: ACTIVITY_PATH,
      }),
    ).rejects.toThrow();

    // And the case a person can create by hand, in Obsidian: an exact-note
    // override publishing the file, which would hand every member an index of
    // every private filename in the context. The next write takes it back.
    f.backend.seed(
      PRIVACY_KEY,
      (fileAt(f.backend, PRIVACY_KEY) as string).replace(
        "note_overrides:",
        `note_overrides:\n  ${ACTIVITY_PATH}: team`,
      ),
    );
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/another.md",
      text: BODY,
    });

    expect(fileAt(f.backend, PRIVACY_KEY)).not.toContain(`${ACTIVITY_PATH}: team`);
    await expect(
      asUser(f.t, f.member).action(api.functions.files.readNote, {
        workspaceId: f.workspaceId,
        path: ACTIVITY_PATH,
      }),
    ).rejects.toThrow();
  });

  test("does not write a line per autosave", async () => {
    const f = await fixture();
    const first = await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/week-one.md",
      text: BODY,
    });
    const before = fileAt(f.backend, ACTIVITY_PATH);
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/week-one.md",
      text: `${BODY}\nand another paragraph entirely, typed a moment later.\n`,
      expectedEtag: first.etag,
    });

    expect(entriesIn(f.backend)).toHaveLength(1);
    // Byte-identical, which is the claim that matters: the second save did not
    // rewrite the file at all, rather than rewriting it to the same thing.
    expect(fileAt(f.backend, ACTIVITY_PATH)).toBe(before);
  });

  test("records a private note privately, and shows a member nothing of it", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects",
      visibility: "team",
    });
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
      text: BODY,
    });
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "3-teams/pay-bands.md",
      text: BODY,
    });

    // Three: the folder publish, the shared note, and the private one.
    const stored = entriesIn(f.backend);
    expect(stored.map((entry) => entry.vis).sort()).toEqual([
      "private",
      "team",
      "team",
    ]);

    const asMember = await asUser(f.t, f.member).action(
      api.functions.files.listActivity,
      { workspaceId: f.workspaceId },
    );
    // The shared note and the folder that was shared — and nothing of the
    // private note, with no gap where it would have been.
    expect(asMember.map((entry) => entry.paths[0])).toEqual([
      "1-projects/shared.md",
      "1-projects",
    ]);

    const asOwner = await asUser(f.t, f.owner).action(
      api.functions.files.listActivity,
      { workspaceId: f.workspaceId },
    );
    expect(asOwner).toHaveLength(3);
  });

  test("drops a note out of the member's view when it is taken back", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects",
      visibility: "team",
    });
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
      text: BODY,
    });
    expect(
      (
        await asUser(f.t, f.member).action(api.functions.files.listActivity, {
          workspaceId: f.workspaceId,
        })
      ).map((entry) => entry.paths[0]),
    ).toContain("1-projects/shared.md");

    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
      visibility: "private",
    });

    // The line was written while the note was shared and still says `team`.
    // What removes it is the live manifest, re-derived per reader — which is
    // why the filter cannot be a stored flag alone.
    expect(
      (
        await asUser(f.t, f.member).action(api.functions.files.listActivity, {
          workspaceId: f.workspaceId,
        })
      ).map((entry) => entry.paths[0]),
    ).not.toContain("1-projects/shared.md");
  });
});

describe("a line follows its note", () => {
  test("a row written before a move points at where the note is now", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/week-one.md",
      text: BODY,
    });
    await asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
      workspaceId: f.workspaceId,
      from: "1-projects/week-one.md",
      to: "1-projects/week-one-renamed.md",
    });

    const entries = await asUser(f.t, f.owner).action(
      api.functions.files.listActivity,
      { workspaceId: f.workspaceId },
    );
    // Every row, not just the move's own: the line that says the note was
    // added was written when it lived somewhere else, and it is the one a
    // tidy-up would otherwise leave pointing at nothing.
    expect(entries.flatMap((entry) => entry.paths)).not.toContain(
      "1-projects/week-one.md",
    );
    expect(entries.some((entry) => entry.paths.includes("1-projects/week-one-renamed.md"))).toBe(
      true,
    );
  });
});

describe("the dot on another context's mark", () => {
  test("a change stamps the workspace row, so another console can see it", async () => {
    const f = await fixture();
    const before = await stampOf(f);
    expect(before).toBeNull();

    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/week-one.md",
      text: BODY,
    });

    const after = await stampOf(f);
    expect(typeof after).toBe("number");
  });

  test("a change nobody would mention stamps nothing", async () => {
    const f = await fixture();
    // A folder is not activity — see the shared module's substance table. The
    // stamp has to follow the *line*, not the operation, or the dot lights for
    // work the list will not explain.
    await asUser(f.t, f.owner).action(api.functions.files.createDirectory, {
      workspaceId: f.workspaceId,
      path: "1-projects/empty",
    });
    expect(await stampOf(f)).toBeNull();
  });

  test("the stamp only ever moves forward", async () => {
    const f = await fixture();
    await f.t.mutation(internal.functions.files.markWorkspaceActivity, {
      workspaceId: f.workspaceId,
      at: Date.now() - 1_000,
    });
    const first = await stampOf(f);
    // Two writers land lines in one context and neither knows about the other.
    // A late stamp that overwrote a newer one would put the dot out while
    // something unread was still there.
    await f.t.mutation(internal.functions.files.markWorkspaceActivity, {
      workspaceId: f.workspaceId,
      at: Date.now() - 60_000,
    });
    expect(await stampOf(f)).toBe(first);
  });

  test("and a clock ahead of ours cannot park a context in the future", async () => {
    const f = await fixture();
    await f.t.mutation(internal.functions.files.markWorkspaceActivity, {
      workspaceId: f.workspaceId,
      at: Date.now() + 86_400_000,
    });
    expect(await stampOf(f)).toBeLessThanOrEqual(Date.now());
  });

  /*
    AND THE LEAK THE STAMP OPENS IF IT IS ONE NUMBER.

    `activityAt` is one timestamp for a whole context. Served to every member,
    it tells somebody who is not the owner the exact minute of a change the
    file refuses them, the tree hides and `list_changes` filters out — a
    private write's clock, in the one corner of the product nobody thinks to
    look at. So there are two stamps, and the query hands over the one the
    reader is entitled to.
  */
  test("a private change never reaches a member's row", async () => {
    const f = await fixture();
    // Private by inheritance: the fixture's manifest shares `1-projects` only
    // where a test says so, and this path is not it.
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "3-teams/pay-bands.md",
      text: BODY,
    });

    const asOwner = await asUser(f.t, f.owner).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    const asMember = await asUser(f.t, f.member).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    const ownerRow = asOwner.find((entry) => entry.workspaceId === f.workspaceId);
    const memberRow = asMember.find((entry) => entry.workspaceId === f.workspaceId);

    expect(typeof ownerRow?.activityAt).toBe("number");
    // Not a smaller number, not a rounded one: nothing at all. A member has
    // been told no more than they were before the write.
    expect(memberRow?.activityAt).toBeUndefined();
  });

  test("and a team change reaches both", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects",
      visibility: "team",
    });
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/week-one.md",
      text: BODY,
    });

    const asMember = await asUser(f.t, f.member).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    const row = asMember.find((entry) => entry.workspaceId === f.workspaceId);
    expect(typeof row?.activityAt).toBe("number");
  });

  test("and the private write does not move the team stamp it sits after", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects",
      visibility: "team",
    });
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/week-one.md",
      text: BODY,
    });
    const before = await f.t.run(
      async (ctx) => (await ctx.db.get(f.workspaceId))?.activityTeamAt ?? null,
    );
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "3-teams/pay-bands.md",
      text: BODY,
    });
    // The private line moved the owner's stamp and left the member's where it
    // was, which is the whole of the rule.
    expect(
      await f.t.run(async (ctx) => (await ctx.db.get(f.workspaceId))?.activityTeamAt ?? null),
    ).toBe(before);
    expect(await stampOf(f)).toBeGreaterThan(before as number);
  });

  test("the console is handed both halves, and never a count", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/week-one.md",
      text: BODY,
    });
    await asUser(f.t, f.owner).mutation(api.functions.files.markActivitySeen, {
      workspaceId: f.workspaceId,
    });

    const listed = await asUser(f.t, f.owner).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    const row = listed.find((entry) => entry.workspaceId === f.workspaceId);
    expect(typeof row?.activityAt).toBe("number");
    expect(typeof row?.activitySeenAt).toBe("number");
    // Two timestamps, and no unread count anywhere on the row: a count would
    // have to be a count of what this reader may see, which is a per-member
    // question over a row every member reads.
    expect(JSON.stringify(row)).not.toContain("unseen");
  });
});

describe("catching up", () => {
  test("starts unread and only ever moves forward", async () => {
    const f = await fixture();
    const seen = () =>
      asUser(f.t, f.owner).query(api.functions.files.activityLastSeen, {
        workspaceId: f.workspaceId,
      });

    expect(await seen()).toBeNull();

    await asUser(f.t, f.owner).mutation(api.functions.files.markActivitySeen, {
      workspaceId: f.workspaceId,
      at: 1_000_000,
    });
    expect(await seen()).toBe(1_000_000);

    // A stale tab, a second device, a clock that disagrees: none of them may
    // make yesterday's work look new again.
    await asUser(f.t, f.owner).mutation(api.functions.files.markActivitySeen, {
      workspaceId: f.workspaceId,
      at: 500_000,
    });
    expect(await seen()).toBe(1_000_000);
  });

  test("a future timestamp is clamped to now", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).mutation(api.functions.files.markActivitySeen, {
      workspaceId: f.workspaceId,
      at: Date.now() + 86_400_000,
    });
    const seen = await asUser(f.t, f.owner).query(api.functions.files.activityLastSeen, {
      workspaceId: f.workspaceId,
    });
    expect(seen).not.toBeNull();
    expect(seen as number).toBeLessThanOrEqual(Date.now());
  });
});

describe("what never reaches the file", () => {
  test("a folder being created is not activity", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.createDirectory, {
      workspaceId: f.workspaceId,
      path: "1-projects/empty",
    });
    expect(fileAt(f.backend, ACTIVITY_PATH)).toBeUndefined();
  });

  test("reading a note is not activity", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/week-one.md",
      text: BODY,
    });
    const before = fileAt(f.backend, ACTIVITY_PATH);
    await asUser(f.t, f.owner).action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/week-one.md",
    });
    expect(fileAt(f.backend, ACTIVITY_PATH)).toBe(before);
  });

  test("no note text reaches the control plane's own tables", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/week-one.md",
      text: `# Week one\n\nzzq-activity-body-marker-never-persist\n${"a".repeat(600)}`,
    });
    const dump = await f.t.run(async (ctx) => {
      const rows = await ctx.db.query("auditEvents").collect();
      const members = await ctx.db.query("workspaceMembers").collect();
      return JSON.stringify([rows, members]);
    });
    expect(dump).not.toContain("zzq-activity-body-marker-never-persist");
  });
});

/** The internal operation is reachable only from inside. */
test("listActivity refuses a caller who is not a member", async () => {
  const f = await fixture();
  const stranger = await createUser(f.t, "stranger@example.invalid");
  await createWorkspace(f.t, stranger, "elsewhere");
  await expect(
    asUser(f.t, stranger).action(api.functions.files.listActivity, {
      workspaceId: f.workspaceId,
    }),
  ).rejects.toThrow();
});

/** Proves the internal reference above is the one the action actually calls. */
test("the activity operation is internal", () => {
  expect(internal.functions.files.runFileOperation).toBeDefined();
});
