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
  trashPath,
} from "../functions/lib/fileOps";
import { assertNotProtectedFolder } from "../functions/lib/fileOps/nameTwins";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "./seededRules.helpers";

const NOW = 1_800_000_000_000;
const OWNER = clearanceOf("private");

/**
 * What the guard decides, on any store. Trash, archive and delete of a main
 * folder are refused by it before any store operation runs, so a plain store
 * answers the rule itself. (A keyed workspace refuses permanent delete for
 * every path, and moves a main folder as its row; `folderJobs.test.ts` covers
 * that side.)
 */
async function protectedOutcome(store: FileStore, path: string, intent: "move" | "remove"): Promise<string> {
  return await assertNotProtectedFolder(store, path, OWNER, intent).then(
    () => "allowed",
    (error: Error) => error.message,
  );
}

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
  test("cannot be trashed, archived or deleted", async () => {
    const store = bucket();
    for (const op of [
      () => trashPath(store, { path: "1-projects", clearance: OWNER, now: NOW }),
      () => archivePath(store, { path: "2-areas", clearance: OWNER, now: NOW }),
    ]) {
      expect((await refusal(op)).message).toMatch(/is a built-in folder/);
    }
    // A keyed workspace refuses permanent delete of any path before the guard is asked, so a main folder is never removed that way either.
    const gone = await refusal(() => deletePath(store, { path: "0-inbox", confirmation: DELETE_CONFIRMATION, clearance: OWNER }));
    expect(gone.message).toMatch(/Permanent delete is not available/);
    expect(store.objects.has("1-projects/README.md") && store.objects.has("2-areas/README.md") && store.objects.has("0-inbox/README.md")).toBe(true);
  });

  test("the guard refuses remove for each of the five, and lets nothing else be removed by its name", async () => {
    const store = bucket();
    for (const folder of ["0-inbox", "1-projects", "2-areas", "3-resources", "4-archive"]) {
      expect(await protectedOutcome(store, folder, "remove")).toMatch(/is a built-in folder/);
    }
    expect(await protectedOutcome(store, "4-clients", "remove")).toBe("allowed");
    expect(await protectedOutcome(store, "recipes", "remove")).toBe("allowed");
  });

  test("a role nobody plays yet is refused by name, whether or not that folder exists", async () => {
    const store = bucket();
    store.objects.delete("4-archive/README.md");
    const error = await refusal(() => trashPath(store, { path: "9-archive", clearance: OWNER, now: NOW }));
    expect(error.message).toMatch(/Archive is a built-in folder/);
  });
});

/**
 * @shyoh's workspace, 2026-10-14: an agent made `projects` beside `Projects`,
 * and both were locked, so the empty duplicate could not be removed. One
 * folder per role is protected (the one `rolesIn` files into); its duplicate
 * is an ordinary folder.
 */
describe("a duplicate of a built-in folder is an ordinary folder", () => {
  function twinned(): MemoryStore & FileStore {
    const store = memoryStore({}) as MemoryStore & FileStore;
    store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
    for (const folder of ["Projects", "projects", "Areas", "Archive", "4-archive"]) store.seed(`${folder}/about.md`, "");
    store.seed("Projects/launch.md", "# Launch\n");
    return store;
  }

  test("the duplicate passes the guard for removal; the real one is refused", async () => {
    const store = twinned();
    expect(await protectedOutcome(store, "projects", "remove")).toBe("allowed");
    expect(await protectedOutcome(store, "Archive", "remove")).toBe("allowed");
    expect(await protectedOutcome(store, "Projects", "remove")).toMatch(/is a built-in folder/);
    const error = await refusal(() => trashPath(store, { path: "Projects", clearance: OWNER, now: NOW }));
    expect(error.message).toMatch(/is a built-in folder/);
    expect(store.objects.has("Projects/launch.md")).toBe(true);
  });

  test("a numbered pair keeps the first protected and frees the second", async () => {
    const store = twinned();
    // `4-archive` sorts before `Archive`, so it is the archive; `Archive` moves like any folder.
    expect(await protectedOutcome(store, "4-archive", "remove")).toMatch(/Archive is a built-in folder/);
    expect(await protectedOutcome(store, "Archive", "move")).toBe("allowed");
  });
});
