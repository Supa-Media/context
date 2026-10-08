/**
 * The five built-in folders (`packages/shared/src/folderRoles.cjs`) cannot be
 * renamed, moved, archived, trashed or deleted through the console's file
 * operations; what is inside them can. Decided by name, so an older
 * `4-archive` is protected exactly like a new `9-archive`.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import {
  archivePath,
  deletePath,
  DELETE_CONFIRMATION,
  FileOpError,
  type FileStore,
  movePath,
  trashPath,
} from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";

const NOW = 1_800_000_000_000;
const OWNER = clearanceOf("private");

function bucket(): MemoryStore & FileStore {
  const store = memoryStore({}) as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  for (const folder of ["0-inbox", "1-projects", "2-areas", "3-resources", "4-archive", "4-clients", "recipes"]) {
    store.seed(`${folder}/README.md`, `# ${folder}\n`);
  }
  store.seed("1-projects/launch/plan.md", "# Plan\n");
  return store;
}

async function refusal(fn: () => Promise<unknown>): Promise<FileOpError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof FileOpError) return error;
    throw error;
  }
  throw new Error("Expected the operation to be refused, but it went ahead.");
}

describe("built-in folders stay where they are", () => {
  test.each(["0-inbox", "1-projects", "2-areas", "3-resources", "4-archive"])("%s cannot be renamed or moved", async (folder) => {
    const store = bucket();
    const error = await refusal(() => movePath(store, { from: folder, to: "elsewhere", clearance: OWNER, now: NOW }));
    expect(error.message).toMatch(/is a built-in folder/);
    expect(store.objects.has(`${folder}/README.md`)).toBe(true);
  });

  test("cannot be trashed, archived or deleted", async () => {
    const store = bucket();
    for (const op of [
      () => trashPath(store, { path: "1-projects", clearance: OWNER, now: NOW }),
      () => archivePath(store, { path: "2-areas", clearance: OWNER, now: NOW }),
      () => deletePath(store, { path: "0-inbox", confirmation: DELETE_CONFIRMATION, clearance: OWNER }),
    ]) {
      expect((await refusal(op)).message).toMatch(/is a built-in folder/);
    }
    expect(store.objects.has("1-projects/README.md") && store.objects.has("2-areas/README.md") && store.objects.has("0-inbox/README.md")).toBe(true);
  });

  test("the refusal is the same for a folder that does not exist", async () => {
    const store = bucket();
    const error = await refusal(() => movePath(store, { from: "9-archive", to: "elsewhere", clearance: OWNER, now: NOW }));
    expect(error.message).toMatch(/Archive is a built-in folder/);
  });

  test("what is inside them, extras and own folders still move", async () => {
    const store = bucket();
    await movePath(store, { from: "1-projects/launch", to: "1-projects/spring-launch", clearance: OWNER, now: NOW });
    expect(store.objects.has("1-projects/spring-launch/plan.md")).toBe(true);
    await movePath(store, { from: "4-clients", to: "customers", clearance: OWNER, now: NOW });
    await movePath(store, { from: "recipes", to: "cooking", clearance: OWNER, now: NOW });
    expect(store.objects.has("customers/README.md") && store.objects.has("cooking/README.md")).toBe(true);
  });
});
