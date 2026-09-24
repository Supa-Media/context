import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "../fixtures.helpers";
import {
  Fixture,
  fixture,
  share,
} from "./fixtures";

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

/**
 * A PASTED IMAGE BORROWS ITS VISIBILITY FROM THE NOTES THAT NAME IT.
 *
 * `attachments/` is a visible folder — that is the point of it, so an embed
 * resolves in Obsidian — and a visible folder is one whose keys a member can
 * *guess*. An image has no row in `privacy.md` and cannot have one (non-
 * negotiable #5 keeps `Scope` two-valued and about notes), so the only honest
 * question is the gateway's: is there a note THIS CALLER CAN SEE that names this
 * file?
 *
 * The case with teeth is the last one: a `member` naming the exact key of an
 * image that only a private note references. The key is in their own bucket and
 * the bytes are one HTTP call away for the owner — what stops them is this gate,
 * and nothing else does.
 */
describe("reading a pasted image", () => {
  /** Put `text` at `path`, passing the etag the note already has. */
  async function rewrite(f: Fixture, path: string, text: string): Promise<void> {
    const existing = await asUser(f.t, f.owner).action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path,
    });
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path,
      text,
      expectedEtag: existing.etag,
    });
  }

  /** Store an image as the owner, and answer with the leaf it landed at. */
  async function pasted(f: Fixture): Promise<string> {
    const stored = await asUser(f.t, f.owner).action(api.functions.files.storeNoteImage, {
      workspaceId: f.workspaceId,
      bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer,
      contentType: "image/png",
    });
    return stored.leaf;
  }

  test("the owner reads back the bytes a note of theirs references", async () => {
    const f = await fixture();
    const leaf = await pasted(f);
    await rewrite(f, "1-projects/shared.md", `# Shared\n\n![[${leaf}|320]]\n`);
    const read = await asUser(f.t, f.owner).action(api.functions.files.readNoteImage, {
      workspaceId: f.workspaceId,
      notePath: "1-projects/shared.md",
      leaf,
    });
    expect(new Uint8Array(read.bytes)).toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(read.contentType).toBe("image/png");
  });

  test("a note that does not name it does not open it", async () => {
    const f = await fixture();
    const leaf = await pasted(f);
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.readNoteImage, {
        workspaceId: f.workspaceId,
        notePath: "1-projects/shared.md",
        leaf,
      }),
    );
    expect(errorCode(error)).toBe("FILE_NOT_FOUND");
  });

  test("a member cannot reach an image only a private note references", async () => {
    const f = await fixture();
    await share(f);
    const leaf = await pasted(f);
    await rewrite(f, "2-areas/private-note.md", `# Private\n\n![[${leaf}]]\n`);

    // Naming the private note is the same absence as naming a note that never
    // existed: the read operation refuses it before the reference is even
    // considered.
    const throughTheNote = await captureError(() =>
      asUser(f.t, f.reader).action(api.functions.files.readNoteImage, {
        workspaceId: f.workspaceId,
        notePath: "2-areas/private-note.md",
        leaf,
      }),
    );
    // And naming a note they CAN see does not help, because that note does not
    // reference the image. This is the guess the visible folder makes possible
    // and the gate is what refuses it.
    const throughAVisibleNote = await captureError(() =>
      asUser(f.t, f.reader).action(api.functions.files.readNoteImage, {
        workspaceId: f.workspaceId,
        notePath: "1-projects/shared.md",
        leaf,
      }),
    );
    expect(errorCode(throughTheNote)).toBe("FILE_NOT_FOUND");
    expect(errorCode(throughAVisibleNote)).toBe("FILE_NOT_FOUND");
    // The owner, whose note it is, still reads it — so the refusals above are
    // the gate and not a broken write.
    const owner = await asUser(f.t, f.owner).action(api.functions.files.readNoteImage, {
      workspaceId: f.workspaceId,
      notePath: "2-areas/private-note.md",
      leaf,
    });
    expect(owner.bytes.byteLength).toBe(8);
  });

  test("a member may not paste at all, because writing is a separate grant", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      asUser(f.t, f.reader).action(api.functions.files.storeNoteImage, {
        workspaceId: f.workspaceId,
        bytes: new Uint8Array([137, 80, 78, 71]).buffer,
        contentType: "image/png",
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
  });

  test("the same bytes pasted twice are one object in the bucket", async () => {
    const f = await fixture();
    const first = await pasted(f);
    const second = await pasted(f);
    expect(second).toBe(first);
    expect(
      [...f.backend.objects.keys()].filter((key) => key.includes("paste-")).length,
    ).toBe(1);
  });
});
