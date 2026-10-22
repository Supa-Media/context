/**
 * A path under a built-in folder's default name goes to the folder doing that
 * job, whether or not the workspace is keyed (`lib/filesFns/jobLens.ts`).
 *
 * Writers name `inbox/...` since the numbers came off built-in folders
 * (owner, 2026-10-21). A workspace not yet renamed still has `0-inbox`, and an
 * unkeyed write to `inbox/memories/...` was refused as a twin of it, so the
 * memory was lost.
 *
 * SABOTAGE (a temporary local edit, reverted): drop the `jobLens` call in
 * `runFileOperationHandler` and the first three tests fail.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { copyTree } from "./fixtures.helpers";
import { fixture, type Fixture } from "./website.helpers";

afterEach(() => vi.unstubAllGlobals());

const run = (f: Fixture, operation: Record<string, unknown>) =>
  f.t.action(internal.functions.files.runFileOperation, { workspaceId: f.workspaceId, scope: "private", operation } as never) as Promise<
    Record<string, unknown>
  >;

async function legacyInbox(): Promise<Fixture> {
  const f = await fixture();
  f.backend.seed("0-inbox/memories/old.md", "# Old\n");
  f.backend.seed("1-projects/plan.md", "# Plan\n");
  await copyTree(f.t, f.workspaceId);
  return f;
}

describe("a default name reaches the folder doing its job", { timeout: 30_000 }, () => {
  test("a write to inbox/ lands in 0-inbox/, and is not refused as its twin", async () => {
    const f = await legacyInbox();
    await run(f, { kind: "write", path: "inbox/memories/new.md", text: "# New\n" });
    expect(f.backend.objects.has("0-inbox/memories/new.md")).toBe(true);
    expect(f.backend.objects.has("inbox/memories/new.md")).toBe(false);
  });

  test("a read by the default name finds the note", async () => {
    const f = await legacyInbox();
    const read = await run(f, { kind: "read", path: "inbox/memories/old.md" });
    expect(read).toMatchObject({ kind: "file", path: "0-inbox/memories/old.md" });
  });

  test("a listing by the default name lists the folder", async () => {
    const f = await legacyInbox();
    const listed = JSON.stringify(await run(f, { kind: "list", path: "inbox/memories" }));
    expect(listed).toContain("old.md");
  });

  test("a folder really called by the plain name is the one written", async () => {
    const f = await fixture();
    f.backend.seed("inbox/about.md", "# Inbox\n");
    await copyTree(f.t, f.workspaceId);
    await run(f, { kind: "write", path: "inbox/a.md", text: "# A\n" });
    expect(f.backend.objects.has("inbox/a.md")).toBe(true);
  });

  test("a path under no job's name is untouched", async () => {
    const f = await legacyInbox();
    await run(f, { kind: "write", path: "notes/a.md", text: "# A\n" });
    expect(f.backend.objects.has("notes/a.md")).toBe(true);
  });
});
