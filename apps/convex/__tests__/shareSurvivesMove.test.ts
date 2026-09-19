/**
 * A SHARE FOLLOWS THE NOTE, NOT THE PATH IT WAS MINTED ON.
 *
 * `shareRead.test.ts` proves what a grant reaches. This proves it goes on
 * reaching it after somebody tidies their context — which, until the
 * forwarding ledger landed, it did not: `shares.entryPath` is a string, a move
 * changed where the note was, and every link the owner had already sent died
 * quietly. Nobody finds out, because the person holding the link is not the
 * person who moved the note.
 *
 * Four properties, and the second is the one with teeth:
 *
 *  1. **A moved note is still reachable through the link already sent.** A
 *     rename, and a folder rename above it, and the chain of both.
 *  2. **A note later created at the old path is NOT reachable through it.**
 *     This is the failure mode that is worse than a dead link: a link minted
 *     on somebody's note quietly re-pointed at a different note, which
 *     inherits an audience its author never chose. Resolving the ledger
 *     *before* the live path is what makes this impossible, and reversing
 *     those two lines is what this test exists to catch.
 *  3. **Forwarding never widens.** A note moved into a private folder is as
 *     absent through the share as it would be if the reader asked for its
 *     current path — the manifest is still re-derived live on every read.
 *  4. **A folder share follows its folder**, including a reader arriving with
 *     a path inside the folder's old name.
 *
 * The whole path is real, as in `shareRead.test.ts`: the real action, the real
 * credential barrier, the real `S3Store` over a `fetch` stub, the real privacy
 * engine. Only the socket is fake.
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
const IMPOSTOR_MARKER = "zzq-impostor-body-marker-7c02-never-shared";

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  lk: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

async function fixture(): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const lk = await createUser(t, "lk@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "atlas");
  await createWorkspace(t, lk, "lk");

  const backend = memoryS3(FAKE_STORAGE.bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  backend.seed(ENTRY, "# Chapter transition\n\nSee [the proposal](proposal.md).\n");
  backend.seed(LINKED, "# Proposal\n\nThe numbers.\n");
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

  await asUser(t, owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId,
    path: "1-projects",
    visibility: "team",
  });

  return { t, owner, lk, workspaceId, backend };
}

async function shareEntry(f: Fixture, path: string = ENTRY): Promise<string> {
  const { token } = await asUser(f.t, f.owner).mutation(api.functions.shares.createShare, {
    workspaceId: f.workspaceId,
    path,
    recipient: "@lk",
  });
  return token;
}

/** A folder link, which has its own bound — see `folderLink.test.ts`. */
async function shareFolder(f: Fixture, path: string): Promise<string> {
  const made = await asUser(f.t, f.owner).action(api.functions.shares.createLinkShare, {
    workspaceId: f.workspaceId,
    path,
    kind: "folder",
  });
  return made.token;
}

function read(f: Fixture, who: Id<"users">, token: string, path?: string) {
  return asUser(f.t, who).action(api.functions.shares.readSharedNote, {
    token,
    ...(path === undefined ? {} : { path }),
  });
}

function move(f: Fixture, from: string, to: string) {
  return asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
    workspaceId: f.workspaceId,
    from,
    to,
  });
}

/* -------------------------------------------------------------------------- */

describe("a link already sent survives the note being moved", () => {
  test("a renamed note still opens through the link", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    await move(f, ENTRY, "1-projects/transition/summary.md");

    const result = await read(f, f.lk, token);
    expect(result.path).toBe("1-projects/transition/summary.md");
    expect(result.entryPath).toBe("1-projects/transition/summary.md");
    expect(result.text).toContain("# Chapter transition");
  });

  test("a renamed folder carries every link into it", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    await move(f, "1-projects/transition", "1-projects/chapter-transition");

    const result = await read(f, f.lk, token);
    expect(result.path).toBe("1-projects/chapter-transition/overview.md");
    expect(result.text).toContain("# Chapter transition");
  });

  test("a rename and then a folder rename resolve as one chain", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    await move(f, ENTRY, "1-projects/transition/summary.md");
    await move(f, "1-projects/transition", "1-projects/chapter-transition");

    const result = await read(f, f.lk, token);
    expect(result.path).toBe("1-projects/chapter-transition/summary.md");
    expect(result.text).toContain("# Chapter transition");
  });

  test("the note's own links still resolve from where it landed", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    await move(f, "1-projects/transition", "1-projects/chapter-transition");

    const result = await read(f, f.lk, token);
    // The link inside the note was rewritten in place by the move; the share's
    // traversal is computed from the note as it is now, so the hop it offers
    // is a live path rather than the one the note carried when it was shared.
    expect(result.links).toContain("1-projects/chapter-transition/proposal.md");
    const hop = await read(f, f.lk, token, "1-projects/chapter-transition/proposal.md");
    expect(hop.text).toContain("# Proposal");
  });
});

describe("what the forwarding must never do", () => {
  /*
    THE ONE THAT IS WORSE THAN A DEAD LINK.

    Reverse the two lines in `readSharedNote` so the live path is tried before
    the ledger, and this is what ships: a note written by somebody else, at an
    address a link was once minted on, handed to whoever still holds the link.
    The author of the new note never chose that audience and has no way to see
    that it happened.
  */
  test("a different note later created at the old path is not served", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    await move(f, ENTRY, "1-projects/transition/summary.md");
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: ENTRY,
      text: `# Something else entirely\n\n${IMPOSTOR_MARKER}\n`,
    });

    const result = await read(f, f.lk, token);
    expect(result.path).toBe("1-projects/transition/summary.md");
    expect(result.text).not.toContain(IMPOSTOR_MARKER);
  });

  test("a note moved into a private folder is absent, not forwarded into", async () => {
    const f = await fixture();
    const token = await shareEntry(f);

    // `2-areas` is private in the seeded manifest, and a move never publishes.
    await move(f, ENTRY, "2-areas/overview.md");

    const error = await captureError(() => read(f, f.lk, token));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });
});

describe("a folder share follows its folder", () => {
  test("the reader arriving on the old folder's path still lands inside", async () => {
    const f = await fixture();
    const token = await shareFolder(f, "1-projects/transition");

    await move(f, "1-projects/transition", "1-projects/chapter-transition");

    const entry = await read(f, f.lk, token);
    expect(entry.kind).toBe("folder");
    expect(entry.entryPath).toBe("1-projects/chapter-transition");

    // The path in a link somebody was sent a month ago, inside the old name.
    const stale = await read(f, f.lk, token, ENTRY);
    expect(stale.path).toBe("1-projects/chapter-transition/overview.md");
    expect(stale.text).toContain("# Chapter transition");
  });

  /*
    THE REQUESTED PATH IS THE READER'S OWN INPUT, AND IT IS RESOLVED TOO.

    Which is worth being explicit about: a link holder can ask about any path
    they like, and the ledger will tell the *server* where it went. Nothing of
    that reaches them. A note that has moved OUT of the shared folder forwards
    to somewhere outside the bound, so the bound refuses it — and the refusal is
    the same `SHARE_UNAVAILABLE` as a path that never existed, so the forwarding
    is not an oracle for where anything went either.
  */
  test("a note that has since moved out of the folder is refused by its old path", async () => {
    const f = await fixture();
    const token = await shareFolder(f, "1-projects/transition");

    await move(f, ENTRY, "2-areas/overview.md");

    const error = await captureError(() => read(f, f.lk, token, ENTRY));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });

  test("and a path outside the folder is still refused", async () => {
    const f = await fixture();
    const token = await shareFolder(f, "1-projects/transition");

    await move(f, "1-projects/transition", "1-projects/chapter-transition");

    const error = await captureError(() => read(f, f.lk, token, "index.md"));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });
});
