/**
 * Opening a note asks for it while `privacy.md` is still on its way.
 *
 * Owner, 2026-10-11: opening a note took seconds. `readFile` used to read
 * `privacy.md`, wait for it, and only then ask for the note: two bucket round
 * trips one after the other on every open. The note is now asked for at the
 * same moment — and `canSee` still decides, against the manifest, before a
 * byte of it is returned. These hold both halves: the overlap, and that it
 * changes nothing about who gets what.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { type FileStore, readFile } from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest, setFolderVisibility, setVisibility } from "./seededRules.helpers";

const OWNER = clearanceOf("private");
const TEAM = clearanceOf("team");

async function bucket(): Promise<MemoryStore & FileStore> {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("1-projects/plan.md", "# Plan\n");
  store.seed("1-projects/pay.md", "# Pay\n\nsalaries\n");
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: OWNER });
  await setVisibility(store, { path: "1-projects/pay.md", visibility: "private", clearance: OWNER });
  return store;
}

/** Hold `privacy.md`'s GET until released, recording every key asked for. */
function holdPrivacy(store: FileStore) {
  const asked: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const get = store.get.bind(store);
  store.get = (async (key: string) => {
    asked.push(key);
    if (key === PRIVACY_KEY) await gate;
    return get(key);
  }) as FileStore["get"];
  return { asked, release: () => release() };
}

async function capture(read: () => Promise<unknown>) {
  try {
    await read();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error("expected a refusal");
}

describe("readFile overlaps the note with privacy.md", () => {
  test("the note is asked for before privacy.md has answered", async () => {
    const store = await bucket();
    const held = holdPrivacy(store);
    const reading = readFile(store, { path: "1-projects/plan.md", clearance: TEAM });
    await Promise.resolve();
    expect(held.asked).toContain(PRIVACY_KEY);
    expect(held.asked).toContain("1-projects/plan.md");
    held.release();
    await expect(reading).resolves.toMatchObject({ text: "# Plan\n" });
  });

  test("a note held back is still refused, exactly as a missing one, and none of it leaves", async () => {
    const store = await bucket();
    const hidden = await capture(() => readFile(store, { path: "1-projects/pay.md", clearance: TEAM }));
    const missing = await capture(() => readFile(store, { path: "1-projects/nothing.md", clearance: TEAM }));
    expect(hidden.code).toBe("FILE_NOT_FOUND");
    expect({ code: hidden.code, message: hidden.message }).toEqual({ code: missing.code, message: missing.message });
    expect(JSON.stringify(hidden)).not.toContain("salaries");
  });

  test("an early GET that fails is asked again, never the reason a read fails", async () => {
    const store = await bucket();
    const get = store.get.bind(store);
    let failures = 1;
    store.get = (async (key: string) => {
      if (key === "1-projects/plan.md" && failures > 0) {
        failures -= 1;
        throw new Error("transient");
      }
      return get(key);
    }) as FileStore["get"];
    await expect(readFile(store, { path: "1-projects/plan.md", clearance: TEAM })).resolves.toMatchObject({ text: "# Plan\n" });
  });
});
