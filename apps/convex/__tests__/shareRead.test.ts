/**
 * READING THROUGH A SHARE — the whole path, against a real bucket.
 *
 * `shares.test.ts` proves the grant. This proves what the grant actually
 * *reaches*, which is the half that can hand somebody a note the owner never
 * meant to send. The whole path is real: the real action, the real credential
 * barrier, the real `S3Store` doing real SigV4 against a `fetch` stub speaking
 * S3, the real `privacy.md` parsed by the real privacy engine. Only the socket
 * is fake.
 *
 * Four properties, each of which fails in a different direction:
 *
 *  1. **A share reads at `team` scope, from the LIVE manifest.** A note that
 *     was team when the share was created and is private now must read as
 *     absent. This is why nothing about visibility is stored on the share row,
 *     and it is the single most important test in this file.
 *  2. **A share reaches the entry note and its links — nothing else.** Not a
 *     sibling, not a parent, not a note merely mentioned in prose, and not a
 *     note linked from a note that was linked (depth is one, on purpose).
 *  3. **Every authorization refusal is one answer.** Revoked, expired, not
 *     yours, note deleted, note made private, target not linked: all
 *     `SHARE_UNAVAILABLE`, so nobody holding a link can tell which happened.
 *  4. **A storage failure is NOT that answer.** A viewer told "unavailable"
 *     during a bucket outage would conclude their access was withdrawn. It is
 *     the one case that must stay distinguishable.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3, type MemoryS3, type MemoryS3Options } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
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

const ENTRY = "1-projects/transition/overview.md";
const LINKED = "1-projects/transition/proposal.md";
const SECOND_HOP = "1-projects/transition/deep.md";
const UNLINKED = "1-projects/transition/unrelated.md";
const PRIVATE_NOTE = "2-areas/salaries.md";

/**
 * A body that could only have come from note content, so a test asserting a
 * leak has found one rather than a coincidence.
 */
const PRIVATE_MARKER = "zzq-private-body-marker-4a91-never-shared";

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  lk: Id<"users">;
  stranger: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

/**
 * An owner with a context whose `1-projects` is team-visible, an outsider
 * (`@lk`) who is not a member, and a stranger who is neither.
 *
 * The entry note links to `proposal.md`, mentions `unrelated.md` in prose
 * without linking it, and links a private note — so the manifest, not the link
 * graph, is what has to refuse that one.
 */
async function fixture(options: MemoryS3Options = {}): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const lk = await createUser(t, "lk@example.invalid");
  const stranger = await createUser(t, "stranger@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "atlas");
  // `@lk` resolves through the personal context that owns the slug.
  await createWorkspace(t, lk, "lk");
  await createWorkspace(t, stranger, "elsewhere");

  const backend = memoryS3(FAKE_STORAGE.bucket, options);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  backend.seed(
    ENTRY,
    [
      "# Chapter transition",
      "",
      "See [the proposal](proposal.md) for the numbers.",
      "The salaries are in 2-areas/salaries.md — ask me for access.",
      "Also [[unrelated-by-name]] does not exist.",
      "And [the private one](/2-areas/salaries.md).",
      "",
    ].join("\n"),
  );
  backend.seed(LINKED, `# Proposal\n\nDeeper: [next](deep.md)\n`);
  backend.seed(SECOND_HOP, "# Deep\n\nTwo hops from the entry note.\n");
  backend.seed(UNLINKED, "# Unrelated\n\nNobody linked to this.\n");
  backend.seed(PRIVATE_NOTE, `# Salaries\n\n${PRIVATE_MARKER}\n`);
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

  // `1-projects` is what a share can reach; `2-areas` stays private.
  await asUser(t, owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId,
    path: "1-projects",
    visibility: "team",
  });

  return { t, owner, lk, stranger, workspaceId, backend };
}

async function shareEntry(f: Fixture, path: string = ENTRY): Promise<string> {
  const { token } = await asUser(f.t, f.owner).mutation(
    api.functions.shares.createShare,
    { workspaceId: f.workspaceId, path, recipient: "@lk" },
  );
  return token;
}

function read(f: Fixture, who: Id<"users">, token: string, path?: string) {
  return asUser(f.t, who).action(api.functions.shares.readSharedNote, {
    token,
    ...(path === undefined ? {} : { path }),
  });
}

/* -------------------------------------------------------------------------- */

describe("what a share reaches", () => {
  test("the recipient reads the entry note", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    const result = await read(f, f.lk, token);
    expect(result.path).toBe(ENTRY);
    expect(result.text).toContain("# Chapter transition");
    expect(result.entryPath).toBe(ENTRY);
  });

  test("the entry note's links come back, so the viewer can offer them", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    const result = await read(f, f.lk, token);
    // `proposal.md` is linked. The private note is linked too — it is listed
    // here because linking is a fact about the text, and refused on read
    // because visibility is a fact about the manifest. The next test proves it.
    expect(result.links).toContain(LINKED);
    expect(result.links).not.toContain(UNLINKED);
  });

  test("a linked note is readable", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    const result = await read(f, f.lk, token, LINKED);
    expect(result.path).toBe(LINKED);
    expect(result.text).toContain("# Proposal");
    expect(result.entryPath).toBe(ENTRY);
  });

  /**
   * Depth is one. `deep.md` is linked from `proposal.md`, which is itself
   * reachable — but a note reached through a share must never become a *source*
   * of further authorization, or anybody with `editor` here could extend
   * somebody else's share by adding a link.
   */
  test("a note two hops out is not reachable", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    const error = await captureError(() => read(f, f.lk, token, SECOND_HOP));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });

  test("a note merely mentioned in prose is not reachable", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    const error = await captureError(() => read(f, f.lk, token, UNLINKED));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });

  test("a sibling nobody linked is not reachable", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    const error = await captureError(() => read(f, f.lk, token, "index.md"));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });
});

describe("visibility is read live, on every request", () => {
  /**
   * THE test. A share carries no stored visibility, so the answer has to come
   * from the manifest as it is right now — otherwise "I made that private" does
   * not take effect until somebody remembers to revoke.
   */
  test("making the entry note private kills the share without revoking it", async () => {
    const f = await fixture();
    const token = await shareEntry(f);
    expect((await read(f, f.lk, token)).path).toBe(ENTRY);

    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: ENTRY,
      visibility: "private",
    });

    const error = await captureError(() => read(f, f.lk, token));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });

  test("making the whole folder private kills it too", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects",
      visibility: "private",
    });

    const error = await captureError(() => read(f, f.lk, token));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });

  /**
   * A link is a fact about the text; visibility is a fact about the manifest.
   * The entry note links to a private note, and linking it must not publish it.
   */
  test("a link to a private note reveals nothing", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    const error = await captureError(() => read(f, f.lk, token, PRIVATE_NOTE));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
    expect(JSON.stringify((error as { data?: unknown }).data)).not.toContain(
      PRIVATE_MARKER,
    );
  });

  test("a share cannot reach the access map even by asking for it", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    const error = await captureError(() => read(f, f.lk, token, PRIVACY_KEY));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });

  test("a share cannot reach history", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    const error = await captureError(() =>
      read(f, f.lk, token, ".history/1-projects/transition/overview.md"),
    );
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });

  test("a traversal path is refused", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    const error = await captureError(() => read(f, f.lk, token, "../../etc/passwd"));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });
});

describe("who may read", () => {
  test("a signed-out caller gets nothing and is told to sign in", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    const error = await captureError(() =>
      f.t.action(api.functions.shares.readSharedNote, { token }),
    );
    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
  });

  test("somebody else's token is worth nothing, and looks like a bad token", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    const stolen = await captureError(() => read(f, f.stranger, token));
    const invented = await captureError(() =>
      read(f, f.stranger, "a-token-that-was-never-issued"),
    );
    expect(errorCode(stolen)).toBe("SHARE_UNAVAILABLE");
    expect(JSON.stringify((stolen as { data?: unknown }).data)).toBe(
      JSON.stringify((invented as { data?: unknown }).data),
    );
  });

  test("a revoked share reads like one that never existed", async () => {
    const f = await fixture();
    const token = await shareEntry(f);
    const listed = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    await asUser(f.t, f.owner).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });

    const revoked = await captureError(() => read(f, f.lk, token));
    const invented = await captureError(() => read(f, f.lk, "never-issued"));
    expect(errorCode(revoked)).toBe("SHARE_UNAVAILABLE");
    expect(JSON.stringify((revoked as { data?: unknown }).data)).toBe(
      JSON.stringify((invented as { data?: unknown }).data),
    );
  });

  test("an expired share stops reading", async () => {
    const f = await fixture();
    const token = await shareEntry(f);
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });

    const error = await captureError(() => read(f, f.lk, token));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });

  /**
   * The recipient is not a member, so nothing else in the product opens to
   * them. A share that quietly granted the ordinary read path would be the
   * `viewer`-role mistake arriving by a different door.
   */
  test("a share grants nothing on the member read path", async () => {
    const f = await fixture();
    await shareEntry(f);

    const error = await captureError(() =>
      asUser(f.t, f.lk).action(api.functions.files.readNote, {
        workspaceId: f.workspaceId,
        path: ENTRY,
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("a share grants no listing", async () => {
    const f = await fixture();
    await shareEntry(f);

    const error = await captureError(() =>
      asUser(f.t, f.lk).action(api.functions.files.listFiles, {
        workspaceId: f.workspaceId,
        path: "1-projects",
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });
});

describe("a deleted note, and a broken bucket, are different answers", () => {
  test("a deleted entry note reads as unavailable", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    await asUser(f.t, f.owner).action(api.functions.files.deleteEntry, {
      workspaceId: f.workspaceId,
      path: ENTRY,
      confirmation: "permanently delete",
    });

    const error = await captureError(() => read(f, f.lk, token));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });

  /**
   * The one refusal that must NOT be `SHARE_UNAVAILABLE`. A viewer told their
   * share is unavailable during a bucket outage goes and asks the owner why
   * their access was withdrawn, and the answer is that it was not.
   */
  test("an unreachable bucket says so, rather than claiming the share is gone", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    // The outage is simulated at the socket rather than with the stub's
    // `unreachable` option, which refuses LIST only — a note read is a GET, so
    // that option leaves this path working and the test would pass vacuously.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNREFUSED")));

    const error = await captureError(() => read(f, f.lk, token));
    expect(errorCode(error)).not.toBe("SHARE_UNAVAILABLE");
    expect(errorCode(error)).toMatch(/^STORAGE_/);
  });

  test("a context with no bucket at all says so too", async () => {
    const f = await fixture();
    const token = await shareEntry(f);
    await f.t.run(async (ctx) => {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique();
      await ctx.db.delete(binding!._id);
    });

    const error = await captureError(() => read(f, f.lk, token));
    expect(errorCode(error)).toBe("STORAGE_NOT_CONNECTED");
  });
});

describe("note content does not stay in the control plane", () => {
  /**
   * CLAUDE.md non-negotiable #1, asserted behaviourally for this path the way
   * `files.test.ts` does for the editor: read a note through a share, then
   * sweep the entire database for its body.
   */
  test("reading through a share writes no note content anywhere", async () => {
    const f = await fixture();
    const token = await shareEntry(f);
    await read(f, f.lk, token);
    await read(f, f.lk, token, LINKED);

    const dump = await f.t.run(async (ctx) => {
      const tables = ["noteShares", "auditEvents", "workspaces", "workspaceMembers"];
      const rows: unknown[] = [];
      for (const table of tables) {
        rows.push(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...(await ctx.db.query(table as any).collect()),
        );
      }
      return JSON.stringify(rows);
    });

    expect(dump).not.toContain("Chapter transition");
    expect(dump).not.toContain("# Proposal");
    expect(dump).not.toContain(PRIVATE_MARKER);
  });
});

/**
 * THE READ PATH IS A THIRD PLACE THAT DECIDES WHO MAY REDEEM A SHARE.
 *
 * `resolveShare` answers a link, `listSharedWithMe` is the recipient's inbox,
 * and `authorizeShareRead` is what stands between a token and the note's bytes.
 * All three were asking the same question — is this share live, and is this
 * caller the identity it names — in three separate copies.
 *
 * That is the shape `CLAUDE.md` names for the gateway: *"Authority is decided
 * once, never per protocol era. A scope check implemented separately for a new
 * protocol revision is a scope check that will drift."* Here the drift had
 * already happened by the time it was noticed: the sweep and the re-check that
 * close a freed handle went into two of the three, and this one — the only one
 * that returns note **content** — kept the older, softer copy.
 *
 * So these are the same two cases `shares.test.ts` proves for the token, run
 * against the bytes.
 */
describe("a share that no longer stands reaches no content either", () => {
  test("the successor to a freed handle reads nothing", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    // Control: the person it was addressed to gets the note.
    const before = await read(f, f.lk, token);
    expect(before.text).toContain("Chapter transition");

    // `@lk` gives up their account; a stranger claims the freed handle.
    await asUser(f.t, f.lk).mutation(api.functions.account.deleteAccount, {});
    const successor = await createUser(f.t, "successor@example.invalid");
    await createWorkspace(f.t, successor, "lk");

    // Not a softer refusal than the token path's — the same one, and no bytes.
    const error = await captureError(() => read(f, successor, token));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });

  test("a share whose context was destroyed reaches nothing", async () => {
    const f = await fixture();
    const token = await shareEntry(f);
    expect((await read(f, f.lk, token)).text).toContain("Chapter transition");

    // Only the workspace document goes, so a row the cascade missed is what is
    // being tested rather than the cascade itself.
    await f.t.run(async (ctx) => {
      await ctx.db.delete(f.workspaceId);
    });

    const error = await captureError(() => read(f, f.lk, token));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });

  test("a sharer who is no longer the owner cannot keep serving bytes", async () => {
    const f = await fixture();
    const token = await shareEntry(f);
    expect((await read(f, f.lk, token)).text).toContain("Chapter transition");

    await f.t.run(async (ctx) => {
      const rows = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .collect();
      for (const row of rows) {
        if (row.userId === f.owner) await ctx.db.patch(row._id, { role: "editor" });
      }
    });

    const error = await captureError(() => read(f, f.lk, token));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });
});
