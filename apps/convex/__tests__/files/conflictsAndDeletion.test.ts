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

/* -------------------------------------------------------------------------- */
/*                                  conflicts                                 */
/* -------------------------------------------------------------------------- */

/**
 * Stand in for somebody creating `key` in the round trip between `writeNote`'s
 * existence read and its put: the first GET of it finds nothing, and by the
 * time the PUT arrives their note is there.
 */
function raceCreate(f: Fixture, key: string, theirs: string): void {
  let raced = false;
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const response = await f.backend.fetchImpl(input, init);
    const url = new URL(typeof input === "string" ? input : String(input));
    if (!raced && (init?.method ?? "GET") === "GET" && url.pathname.endsWith(`/${key}`)) {
      raced = true;
      f.backend.seed(key, theirs);
    }
    return response;
  });
}

describe("a stale save is a conflict, never a silent overwrite", () => {
  test("a create that lost a race to somebody else's is a conflict, and theirs survives", async () => {
    const f = await fixture();
    raceCreate(f, "1-projects/new.md", "# Theirs\n");
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: "1-projects/new.md",
        text: "# Mine\n",
      }),
    );
    expect(errorCode(error)).toBe("CONFLICT");
    expect((error as { data: { currentEtag?: string } }).data.currentEtag).toBe(
      f.backend.objects.get("1-projects/new.md")!.etag,
    );
    expect(f.backend.snapshot()["1-projects/new.md"]).toBe("# Theirs\n");
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
    expect(f.backend.snapshot()["1-projects/shared.md"]).toContain("Human edit");
    expect(f.backend.snapshot()["1-projects/shared.md"]).toContain("Agent edit");
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
        f.backend.objects.get("1-projects/shared.md")!.etag,
      );
    }
    expect(f.backend.snapshot()["1-projects/shared.md"]).toBe("# Theirs\n");
    expect(f.backend.snapshot()["1-projects/renamed.md"]).toBeUndefined();
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
