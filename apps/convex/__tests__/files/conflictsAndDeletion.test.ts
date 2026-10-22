import { describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import { DELETE_CONFIRMATION } from "../../functions/lib/fileOps";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import {
  FAKE_STORAGE,
  type TestConvex,
  asUser,
  captureError,
  errorCode,
} from "../fixtures.helpers";
import {
  SECRET_BODY_MARKER,
  Fixture,
  fixture,
  share,
} from "./fixtures.helpers";
import { bodyAtPath, etagAtPath, noteBodies } from "./keyedNotes.helpers";

/* -------------------------------------------------------------------------- */
/*                                  conflicts                                 */
/* -------------------------------------------------------------------------- */

/**
 * Stand in for somebody creating a note in the round trip between `writeNote`'s
 * existence read and its put. A keyed create writes to a key the product just
 * chose (`notes/<noteId>.md`), so the first PUT of a new note key finds their
 * note already there: the create must be refused, and theirs must survive.
 * Returns the key that was raced, once it has been.
 */
function raceCreate(f: Fixture, theirs: string): () => string | undefined {
  let raced: string | undefined;
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/").slice(1).join("/"));
    if (raced === undefined && (init?.method ?? "GET") === "PUT" && key.startsWith("notes/")) {
      raced = key;
      f.backend.seed(key, theirs);
    }
    return await f.backend.fetchImpl(input, init);
  });
  return () => raced;
}

describe("a stale save is a conflict, never a silent overwrite", () => {
  test("a create that lost a race to somebody else's is a conflict, and theirs survives", async () => {
    const f = await fixture();
    const raced = raceCreate(f, "# Theirs\n");
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: "1-projects/new.md",
        text: "# Mine\n",
      }),
    );
    const key = raced();
    expect(key).toMatch(/^notes\/.+\.md$/);
    expect(errorCode(error)).toBe("CONFLICT");
    expect((error as { data: { currentEtag?: string } }).data.currentEtag).toBe(
      f.backend.objects.get(key!)!.etag,
    );
    expect(f.backend.snapshot()[key!]).toBe("# Theirs\n");
  });

  test("a create on a bucket that never proved create-only writes says it was a read-compare", async () => {
    const f = await fixture({ conditionalCreate: false });
    const written = await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/new.md",
      text: "# Mine\n",
    });
    expect(written.conflictCheck).toBe("read-compare");
  });

  test("a retained base merges an unseen save instead of clobbering it", async () => {
    const f = await fixture();
    const as = asUser(f.t, f.owner);
    const first = await as.action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
    });
    await as.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: first.path,
      text: "# Shared\nBody\nHuman edit\n",
      expectedEtag: first.etag,
    });

    const merged = await as.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: first.path,
      text: "# Shared\nBody\nAgent edit\n",
      expectedEtag: first.etag,
    });
    expect(merged.etag).toMatch(/^c2\./);
    const body = await bodyAtPath(f, "1-projects/shared.md");
    expect(body).toContain("Human edit");
    expect(body).toContain("Agent edit");
  });

  /*
    The offline queue's rename, move and delete: each sent with the version it
    was asked about, through the same actions an online press uses.
    `offlineFileOps.test.ts` has the rules; this is that they reach the client.
  */
  test("a queued rename or delete of a note that changed is a conflict with the current etag", async () => {
    const f = await fixture();
    const as = asUser(f.t, f.owner);
    const read = await as.action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
    });
    await as.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: read.path,
      text: "# Theirs\n",
      expectedEtag: read.etag,
    });

    for (const attempt of [
      () => as.action(api.functions.files.moveEntry, {
        workspaceId: f.workspaceId,
        from: read.path,
        to: "1-projects/renamed.md",
        expectedEtag: read.etag,
      }),
      () => as.action(api.functions.files.trashEntry, {
        workspaceId: f.workspaceId,
        path: read.path,
        expectedEtag: read.etag,
      }),
      () => as.action(api.functions.files.archiveEntry, {
        workspaceId: f.workspaceId,
        path: read.path,
        expectedEtag: read.etag,
      }),
    ]) {
      const error = await captureError(attempt);
      expect(errorCode(error)).toBe("CONFLICT");
      expect((error as { data: { currentEtag?: string } }).data.currentEtag).toBe(
        await etagAtPath(f, "1-projects/shared.md"),
      );
    }
    expect(await bodyAtPath(f, "1-projects/shared.md")).toBe("# Theirs\n");
    expect(await bodyAtPath(f, "1-projects/renamed.md")).toBeNull();
  });

  test("a queued rename at the version it was asked about lands, and says the note's new etag", async () => {
    const f = await fixture();
    const as = asUser(f.t, f.owner);
    const read = await as.action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
    });
    const moved = await as.action(api.functions.files.moveEntry, {
      workspaceId: f.workspaceId,
      from: read.path,
      to: "1-projects/renamed.md",
      expectedEtag: read.etag,
    });
    const renamed = await as.action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/renamed.md",
    });
    expect(moved.etag).toBe(renamed.etag);
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
    expect(await bodyAtPath(f, "1-projects/shared.md")).toBe("# Theirs\n");
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
    expect(await bodyAtPath(f, "1-projects/shared.md")).toBe("# Shared\n");
  });

  /*
    A keyed note's row and its key are retired only by emptying the trash
    (`lib/fileOps/deleting.ts`), so a permanent delete is refused here, before
    anything is read or removed. The erasure itself is `trash/emptying.test.ts`.
  */
  test("a permanent delete is refused in a keyed workspace, and keeps the note", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.deleteEntry, {
        workspaceId: f.workspaceId,
        path: "2-areas/private-note.md",
        confirmation: DELETE_CONFIRMATION,
      }),
    );
    expect(errorCode(error)).toBe("KEYED_WORKSPACE");
    expect(await bodyAtPath(f, "2-areas/private-note.md")).toContain(SECRET_BODY_MARKER);
  });

  test("archiving is recoverable — the note is still in the bucket", async () => {
    const f = await fixture();
    const archived = await asUser(f.t, f.owner).action(api.functions.files.archiveEntry, {
      workspaceId: f.workspaceId,
      path: "2-areas/private-note.md",
    });
    expect(await bodyAtPath(f, archived.to)).toContain(SECRET_BODY_MARKER);

    await asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
      workspaceId: f.workspaceId,
      from: archived.to,
      to: "2-areas/private-note.md",
    });
    expect(await bodyAtPath(f, "2-areas/private-note.md")).toContain(SECRET_BODY_MARKER);
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
    expect(Object.values(noteBodies(f.backend)).join("")).toContain(SECRET_BODY_MARKER);
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
    // A keyed workspace takes nothing permanently: a removal is a trash, audited as an archive.
    await as.action(api.functions.files.trashEntry, {
      workspaceId: f.workspaceId,
      path: "1-projects/a copy.md",
    });

    const events = await asUser(f.t, f.owner).query(api.functions.audit.listEvents, {
      workspaceId: f.workspaceId,
    });
    const actions = events.map((event) => event.action);
    expect(actions).toContain("file.create");
    expect(actions).toContain("file.duplicate");
    expect(actions).toContain("file.archive");
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
    const f = await fixture();
    // The provider refuses every write from here on, quoting the key it was given.
    const providerSays = `signature mismatch for ${FAKE_STORAGE.accessKeyId}`;
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT") {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>${providerSays}</Message></Error>`,
          { status: 403, headers: { "content-type": "application/xml" } },
        );
      }
      return await f.backend.fetchImpl(input, init);
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
