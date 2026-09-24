import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import { DELETE_CONFIRMATION } from "../../functions/lib/fileOps";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import {
  asUser,
  captureError,
  errorCode,
} from "../fixtures.helpers";
import {
  fixture,
  share,
  errorShape,
} from "./fixtures";

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

    const migrationError = await captureError(() =>
      asUser(f.t, f.reader).action(api.functions.files.updateStorageLayout, {
        workspaceId: f.workspaceId,
      }),
    );
    expect(errorCode(migrationError)).toBe("INSUFFICIENT_ROLE");
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

  /**
   * AND THE ENUMERATION WENT STALE AGAIN, THE MOMENT A NEW WRITE DOOR OPENED.
   *
   * `removeNoteEncryption` is the one action in this file that writes plaintext
   * over an encrypted note, and it arrived after the list above was last
   * checked. Measured the way that comment says to measure: with its
   * `minimum: "editor"` lowered to `"member"`, the whole `apps/convex` run
   * stayed green — 2170 of 2170 — so nothing at all was holding the bar on the
   * most destructive write the console has. A read-only member could have
   * replaced a locked note they were shared with by plaintext of their own
   * choosing, destroying ciphertext nobody — not the owner, not us — can
   * reconstruct.
   *
   * It gets its own test rather than a tenth entry in the loop above because
   * the loop's notes are all `# Shared\n`, and this door refuses an unencrypted
   * note (`NOTE_NOT_ENCRYPTED`) before its role gate would ever matter: a row
   * there would assert the wrong refusal and stay green with the bar on the
   * floor. Here the note really is encrypted, so a lowered bar lands the write
   * and both halves of the assertion fail — the refusal and the bytes.
   */
  test("a read-only member cannot remove a locked note's encryption", async () => {
    const f = await fixture();
    await share(f);
    const locked = [
      "---",
      "context_encryption: v1",
      "---",
      "",
      "> [!NOTE] This note is encrypted.",
      "",
      "```context-encrypted",
      '{"v":1,"alg":"A256GCM","iv":"AAAAAAAAAAAAAAAA","ct":"AAAA",' +
        '"aad":"context-note-v1:ws_x","recipients":[{"kind":"passphrase","id":"p1",' +
        '"alg":"A256GCM","iv":"BBBBBBBBBBBBBBBB","wrapped":"CCCC"}]}',
      "```",
      "",
    ].join("\n");
    f.backend.seed("1-projects/locked.md", locked);

    const error = await captureError(() =>
      asUser(f.t, f.reader).action(api.functions.files.removeNoteEncryption, {
        workspaceId: f.workspaceId,
        path: "1-projects/locked.md",
        text: "# I took the lock off a note I can only read\n",
      }),
    );

    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect(f.backend.snapshot()["1-projects/locked.md"]).toBe(locked);
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

