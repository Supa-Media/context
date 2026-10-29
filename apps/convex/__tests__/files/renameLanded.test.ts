/**
 * A RENAME THAT HAS LANDED IS ANSWERED AS LANDED, AND IT READS THE NOTE AS FEW TIMES AS IT CAN.
 *
 * Dev2 (2026-10-29): renaming "seems to be slow and breaks at times". A rename
 * from the app is a row change in Convex, then the bucket's side: the version
 * the note is handed out at, forwarding, icons, the search index, the activity
 * line, and the heading following the new name.
 *
 *  - Everything after the rows moved used to be able to fail the call. With the
 *    bucket not answering for a moment, the note was renamed and the app was
 *    told "Your bucket did not complete that request", so it drew the note back
 *    at a name that no longer existed and its next save made a second note
 *    there.
 *  - The heading's follow read the whole collaboration document three times
 *    over (the move's own handed version, the heading's read, and the save's
 *    base) before the save loaded it a fourth time to write.
 *
 * Sabotage (temporary local edits, reverted), each failing a case here:
 *  - `followHeading` rethrowing what it catches: the first case is refused;
 *  - `movePath` not passing `handOut: false` for a heading follow: three loads;
 *  - `writeFile` reading the document before replacing its text: three loads.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import { memoryS3, type MemoryS3 } from "../storeStub.helpers";
import { FAKE_STORAGE, asUser, copyTree, createUser, createWorkspace, setupTest, type TestConvex } from "../fixtures.helpers";
import { bodyAtPath, keyAtPath } from "./keyedNotes.helpers";

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
  /** While true, every bucket request fails as a dropped connection does. */
  down: { value: boolean };
}

async function fixture(): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  const backend = memoryS3(FAKE_STORAGE.bucket, {});
  backend.seed("index.md", "# Context\n");
  backend.seed("1-projects/plan.md", "# Plan\n\nThe body.\n");
  const down = { value: false };
  vi.stubGlobal("fetch", (input: URL | RequestInfo, init?: RequestInit) =>
    down.value ? Promise.reject(new TypeError("fetch failed")) : backend.fetchImpl(input, init));
  const encryptedSecretAccessKey = await encryptSecret(FAKE_STORAGE.secretAccessKey, requireKeyset(), { workspaceId });
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await copyTree(t, workspaceId);
  return { t, owner, workspaceId, backend, down };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a rename from the app", { timeout: 60_000 }, () => {
  test("is answered as made when the bucket stops answering after the rows moved", async () => {
    const f = await fixture();
    // The rows move in Convex before the bucket is asked anything, so this is the bucket failing just after.
    f.down.value = true;
    const moved = await asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
      workspaceId: f.workspaceId,
      from: "1-projects/plan.md",
      to: "1-projects/plan-2.md",
      followHeading: true,
    });
    f.down.value = false;
    expect(moved).toMatchObject({ from: "1-projects/plan.md", to: "1-projects/plan-2.md" });
    expect(await keyAtPath(f, "1-projects/plan.md")).toBeNull();
    // Renamed, with the heading it had: the follow could not run, and the next title edit links them again.
    expect(await bodyAtPath(f, "1-projects/plan-2.md")).toBe("# Plan\n\nThe body.\n");
  });

  test("of an open note, with its heading following, loads its document twice: to read it and to write it", async () => {
    const f = await fixture();
    // Opened first, as a note renamed from its own page is: its document exists.
    const opened = await asUser(f.t, f.owner).action(api.functions.files.readNote, { workspaceId: f.workspaceId, path: "1-projects/plan.md" });
    expect(opened.etag).toMatch(/^c2\./);
    const key = await keyAtPath(f, "1-projects/plan.md");
    const head = `.context/collaboration/v1/heads/${key!.replace(/\.md$/, "")}.json`;
    f.backend.requests.length = 0;

    const moved = await asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
      workspaceId: f.workspaceId,
      from: "1-projects/plan.md",
      to: "1-projects/plan-2.md",
      followHeading: true,
    });

    const loads = f.backend.requests.filter((request) => request.method === "GET" && request.key === head).length;
    expect(loads).toBe(2);
    expect(await bodyAtPath(f, "1-projects/plan-2.md")).toBe("# plan-2\n\nThe body.\n");
    // The version handed back is the one a read of the new name hands out.
    const read = await asUser(f.t, f.owner).action(api.functions.files.readNote, { workspaceId: f.workspaceId, path: "1-projects/plan-2.md" });
    expect(moved.etag).toBe(read.etag);
  });

  test("with no heading to follow still hands back the version a read gives", async () => {
    const f = await fixture();
    const moved = await asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
      workspaceId: f.workspaceId,
      from: "1-projects/plan.md",
      to: "1-projects/plan-2.md",
    });
    const read = await asUser(f.t, f.owner).action(api.functions.files.readNote, { workspaceId: f.workspaceId, path: "1-projects/plan-2.md" });
    expect(moved.etag).toBe(read.etag);
    expect(read.text).toBe("# Plan\n\nThe body.\n");
  });
});
