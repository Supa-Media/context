/**
 * THE SIDE PANEL READS A NOTE'S WORDS AT THE READER'S CLEARANCE, AND NO OTHER.
 *
 * A folder page's side panel shows the note a row is (`readBody`). It reads
 * this device's copy at exactly the clearance the page's lists are read at —
 * a team reader is never handed a body the mirror filed under private — and
 * otherwise the bucket through the server, which applies the same clearance.
 * An encrypted note is said to be one, never its ciphertext. Sabotage-checked:
 * reading the private slot for a team source fails "never the private copy".
 */

import { beforeEach, describe, expect, test } from "@jest/globals";
import { currentEpoch } from "../features/offline/epoch";
import { putMirroredNotes } from "../features/offline/mirror";
import { memoryMirrorStore, type MirrorStore } from "../features/offline/mirrorStoreCore";
import { folderListSource, type FolderListIO } from "../features/offline/folderListSource";
import type { OpenNote } from "../features/console/files/types";

const W = "ws_one";
let store: MirrorStore;
let served: string[];

const note = (path: string, text: string, encrypted = false): OpenNote => ({
  path,
  text,
  etag: `e-${path}`,
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: encrypted,
  ...(encrypted ? { encrypted: true } : {}),
});

const io = (bucket: Record<string, OpenNote>): FolderListIO => ({
  readNote: async (path) => {
    served.push(path);
    const found = bucket[path];
    if (found === undefined) throw new Error("not found");
    return found;
  },
  writeNote: async () => {
    throw new Error("no writes here");
  },
});

const source = (scope: "private" | "team", bucket: Record<string, OpenNote> = {}) =>
  folderListSource({ workspaceId: W, scope, canEdit: false, io: io(bucket), openMirror: async () => store, needed: async () => () => new Set() });

beforeEach(async () => {
  store = memoryMirrorStore();
  served = [];
  const epoch = currentEpoch();
  await putMirroredNotes(store, epoch, "private", W, [note("1-projects/web/plan.md", "# Plan\n\nPrivate words.\n")], () => new Set(), 1);
  await putMirroredNotes(store, epoch, "team", W, [note("1-projects/web/brief.md", "# Brief\n\nTeam words.\n")], () => new Set(), 1);
});

describe("a note's words for the side panel", () => {
  test("come from this device's copy when it holds them", async () => {
    expect(await source("team").readBody!("1-projects/web/brief.md")).toEqual({ text: "# Brief\n\nTeam words.\n", encrypted: false });
    expect(served).toEqual([]);
  });

  test("never the private copy for a team reader: the server is asked, and answers for that reader", async () => {
    const answer = await source("team").readBody!("1-projects/web/plan.md");
    expect(answer).toBeNull();
    expect(served).toEqual(["1-projects/web/plan.md"]);
  });

  test("from the bucket when the device has not got them yet, and nothing when neither has", async () => {
    const bucket = { "1-projects/web/new.md": note("1-projects/web/new.md", "# New\n") };
    expect(await source("team", bucket).readBody!("1-projects/web/new.md")).toEqual({ text: "# New\n", encrypted: false });
    expect(await source("team", bucket).readBody!("1-projects/web/gone.md")).toBeNull();
  });

  test("an encrypted note is said to be one, and its ciphertext is not handed over", async () => {
    const bucket = { "1-projects/web/secret.md": note("1-projects/web/secret.md", "---\ncontext_encryption: v1\n---\nciphertext", true) };
    expect(await source("team", bucket).readBody!("1-projects/web/secret.md")).toEqual({ text: "", encrypted: true });
  });
});
