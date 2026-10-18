/**
 * The one-time tidy of Archive's date folders (board 10, owner 2026-10-18;
 * `functions/archiveTidy.ts`, `lib/fileOps/archiving.ts` `tidyArchive`): each
 * note under `9-archive/<date>/` moves to its matching place in Archive, a
 * name already there is merged into with a taken note numbered, and the
 * emptied date folders go.
 *
 * Sabotage, run as a temporary local edit and reverted: skip the stamp
 * filter in `tidyArchive` (tidy every child of Archive) and the "leaves
 * everything else where it is" case fails; drop the `mergeInto` numbering and
 * the clash case overwrites or refuses.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { renderPrivacyManifest } from "../../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import { memoryS3 } from "../storeStub.helpers";
import { FAKE_STORAGE, asUser, copyTree, createUser, createWorkspace, setupTest } from "../fixtures.helpers";

const DAY_ONE = "2026-10-15T22-16-49-545Z";
const DAY_TWO = "2026-10-16T09-02-11-120Z";

async function fixture(seed: Record<string, string>) {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  const backend = memoryS3(FAKE_STORAGE.bucket, {});
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  backend.seed("1-projects/plan.md", "# Plan\n");
  for (const [key, body] of Object.entries(seed)) backend.seed(key, body);
  vi.stubGlobal("fetch", backend.fetchImpl);
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
  return { t, owner, workspaceId, backend };
}

type F = Awaited<ReturnType<typeof fixture>>;

/** Every note path the tree draws under `folder`, walking its listing as the owner. */
async function notesUnder(f: F, folder: string): Promise<string[]> {
  const listing = await asUser(f.t, f.owner).query(api.functions.nodesListing.listFolder, { workspaceId: f.workspaceId as Id<"workspaces">, path: folder });
  const found: string[] = [];
  for (const entry of (listing?.entries ?? []) as { path: string; kind: string }[]) {
    if (entry.kind === "folder") found.push(...(await notesUnder(f, entry.path)));
    else found.push(entry.path);
  }
  return found.sort();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tidying Archive's date folders", () => {
  test("each note moves to its matching place, a taken name numbered, and the date folders go", async () => {
    const f = await fixture({
      [`9-archive/${DAY_ONE}/1-projects/mail-live-check.md`]: "# Mail\n",
      [`9-archive/${DAY_TWO}/2-areas/health/old-card.md`]: "# Card\n",
      [`9-archive/${DAY_TWO}/1-projects/mail-live-check.md`]: "# Mail again\n",
      [`9-archive/${DAY_TWO}/root-note.md`]: "# Root\n",
      "9-archive/1-projects/kept.md": "# Kept\n",
    });

    const tidied = await f.t.action(internal.functions.archiveTidy.tidyWorkspace, { workspaceId: f.workspaceId });

    expect(tidied.left).toBe(false);
    expect(await notesUnder(f, "9-archive")).toEqual([
      "9-archive/1-projects/kept.md",
      "9-archive/1-projects/mail-live-check (2).md",
      "9-archive/1-projects/mail-live-check.md",
      "9-archive/2-areas/health/old-card.md",
      "9-archive/root-note.md",
    ]);
  });

  test("a workspace with nothing to tidy leaves everything where it is", async () => {
    const f = await fixture({ "9-archive/1-projects/kept.md": "# Kept\n", "9-archive/2026-10-15/notes.md": "# Not a date folder\n" });
    const tidied = await f.t.action(internal.functions.archiveTidy.tidyWorkspace, { workspaceId: f.workspaceId });
    expect(tidied).toEqual({ moved: 0, left: false });
    expect(await notesUnder(f, "9-archive")).toEqual(["9-archive/1-projects/kept.md", "9-archive/2026-10-15/notes.md"]);
  });
});
