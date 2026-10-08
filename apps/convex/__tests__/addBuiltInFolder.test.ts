/**
 * "Add a folder" for a built-in role (`lib/fileOps/builtInFolders.ts`): the
 * fixed name, a README saying what it is for, never a second folder for a role
 * the workspace already has under any number, and nothing disclosed about a
 * folder the caller cannot see.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { FileOpError, type FileStore } from "../functions/lib/fileOps";
import { addBuiltInFolder } from "../functions/lib/fileOps/builtInFolders";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";

const NOW = 1_800_000_000_000;
const OWNER = clearanceOf("private");

function bucket(folders = ["0-inbox", "1-projects", "2-areas", "3-resources", "9-archive"]): MemoryStore & FileStore {
  const store = memoryStore({}) as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  for (const folder of folders) store.seed(`${folder}/README.md`, `# ${folder}\n`);
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

describe("adding a built-in folder", () => {
  test.each([
    ["clients", "4-clients", "# Clients"],
    ["teams", "5-teams", "# Teams"],
    ["products", "6-products", "# Products"],
  ])("%s lands at its fixed name with a README saying what it is for", async (role, folder, heading) => {
    const store = bucket();
    expect(await addBuiltInFolder(store, { role, clearance: OWNER, now: NOW })).toEqual({
      path: folder,
      readme: `${folder}/README.md`,
    });
    const readme = store.snapshot()[`${folder}/README.md`];
    expect(typeof readme === "string" && readme.startsWith(`${heading}\n\nOne folder per`)).toBe(true);
  });

  test("a missing main folder can be added back too", async () => {
    const store = bucket(["0-inbox", "1-projects", "4-archive"]);
    expect((await addBuiltInFolder(store, { role: "resources", clearance: OWNER, now: NOW })).path).toBe("3-resources");
  });

  test.each([["archive", "4-archive"], ["clients", "clients"], ["clients", "7-Clients"]])(
    "a workspace that already has %s (as %s) is told so, not given a second one",
    async (role, existing) => {
      const store = bucket(["0-inbox", "1-projects", existing]);
      const error = await refusal(() => addBuiltInFolder(store, { role, clearance: OWNER, now: NOW }));
      expect(error.code).toBe("DESTINATION_EXISTS");
      expect(Object.keys(store.snapshot()).filter((key) => key.endsWith("README.md")).length).toBe(3);
    },
  );

  test.each(["recipes", "", "../clients", "4-clients"])("refuses %j, which is not a role", async (role) => {
    const error = await refusal(() => addBuiltInFolder(bucket(), { role, clearance: OWNER, now: NOW }));
    expect(error.code).toBe("PATH_INVALID");
  });

  test("a member whose folders are private answers not found, whether or not it exists", async () => {
    const member = clearanceOf("team");
    const absent = await refusal(() => addBuiltInFolder(bucket(), { role: "clients", clearance: member, now: NOW }));
    const present = await refusal(() =>
      addBuiltInFolder(bucket(["4-clients"]), { role: "clients", clearance: member, now: NOW }),
    );
    expect([absent.code, absent.message]).toEqual([present.code, present.message]);
    expect(absent.code).toBe("FILE_NOT_FOUND");
  });
});
