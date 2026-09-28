/**
 * FACES — what a person is drawn with, and who may see it.
 *
 * Initials are gone (Dev2, 2026-09-28). A person is drawn with a photo they
 * uploaded, else their personal workspace's icon, else a silhouette. Three
 * properties carry the weight:
 *
 *  1. **Only people you share a workspace with.** A face is shown next to a
 *     handle the viewer already meets in a shared workspace; nobody else's is
 *     returned, so this cannot be used to look up strangers.
 *  2. **The workspace photo path cannot name an object.** It takes a person
 *     and reads the leaf off that person's own row, and it reaches another
 *     person's bucket, so its gate is asserted directly too.
 *  3. **A photo is checked before it is stored, and deleted with its person.**
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   peopleSharingWith returns every user (no membership walk)       1
 *   maySeeFace always true                                          2
 *   uploaded photo ranked below the workspace icon                  1
 *   drop the content-type check on setMyPhoto                       2
 *   drop deleteAccountPhoto from personalRows                       1
 *   add a `leaf` argument to workspacePhoto                         1
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import * as faceFunctions from "../functions/faces";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { WORKSPACE_ICON_MAX_BYTES } from "@context/shared";
import { memoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedStorageBinding,
  setupTest,
} from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PHOTO = new Uint8Array(256);
for (let i = 0; i < PHOTO.length; i += 1) PHOTO[i] = i;

async function fixture() {
  const t = setupTest();
  const seyi = await createUser(t, "seyi@example.invalid");
  const shay = await createUser(t, "shay@example.invalid");
  const stranger = await createUser(t, "stranger@example.invalid");
  const seyiHome = await createWorkspace(t, seyi, "seyi");
  const shayHome = await createWorkspace(t, shay, "shay");
  await createWorkspace(t, stranger, "stranger");
  const team = await createWorkspace(t, seyi, "atlas-crew", { kind: "shared" });
  await addMember(t, team, shay, "member", seyi);
  await asUser(t, seyi).mutation(api.functions.workspaces.setWorkspaceIcon, {
    workspaceId: seyiHome,
    emoji: "🧠",
  });
  await asUser(t, stranger).mutation(api.functions.workspaces.setWorkspaceIcon, {
    workspaceId: (await t.run((ctx) =>
      ctx.db.query("workspaces").withIndex("by_slug", (q) => q.eq("slug", "stranger")).unique(),
    ))!._id,
    emoji: "🦊",
  });
  return { t, seyi, shay, stranger, seyiHome, shayHome, team };
}

type F = Awaited<ReturnType<typeof fixture>>;

async function peopleAs(f: F, who: Id<"users">) {
  return await asUser(f.t, who).query(api.functions.faces.myPeople, {});
}

async function faceOfHandle(f: F, who: Id<"users">, handle: string) {
  return (await peopleAs(f, who)).people.find((row) => row.handle === handle)?.face;
}

/** Give shay's personal workspace an icon photo in a stub bucket. */
async function shayWorkspacePhoto(f: F) {
  const backend = memoryS3(FAKE_STORAGE.bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  vi.stubGlobal("fetch", backend.fetchImpl);
  await seedStorageBinding(f.t, { workspaceId: f.shayHome, boundBy: f.shay });
  const { leaf } = await asUser(f.t, f.shay).action(api.functions.files.setWorkspaceIconPhoto, {
    workspaceId: f.shayHome,
    bytes: PHOTO.buffer,
    contentType: "image/png",
  });
  return leaf;
}

describe("who you see", () => {
  test("a co-member's workspace emoji, by their handle", async () => {
    const f = await fixture();
    expect(await faceOfHandle(f, f.shay, "@seyi")).toEqual({ kind: "emoji", emoji: "🧠" });
    expect(await faceOfHandle(f, f.seyi, "@shay")).toEqual({ kind: "none" });
  });

  test("your own face is in the answer, with whether you uploaded it", async () => {
    const f = await fixture();
    const mine = await peopleAs(f, f.seyi);
    expect(mine.me).toEqual({ person: f.seyi, face: { kind: "emoji", emoji: "🧠" }, uploaded: false });
    expect(mine.people.map((row) => row.handle)).toContain("@seyi");
  });

  test("a stranger is never named, however their face is set", async () => {
    const f = await fixture();
    const handles = (await peopleAs(f, f.seyi)).people.map((row) => row.handle);
    expect(handles).not.toContain("@stranger");
    const theirs = (await peopleAs(f, f.stranger)).people.map((row) => row.handle);
    expect(theirs).toEqual(["@stranger"]);
  });

  test("signed out gets nothing", async () => {
    const f = await fixture();
    expect(await f.t.query(api.functions.faces.myPeople, {})).toEqual({ me: null, people: [] });
  });
});

describe("an uploaded photo", () => {
  test("wins over the workspace icon, and clearing it brings the icon back", async () => {
    const f = await fixture();
    await asUser(f.t, f.seyi).action(api.functions.faces.setMyPhoto, {
      bytes: PHOTO.buffer,
      contentType: "image/jpeg",
    });
    const face = await faceOfHandle(f, f.shay, "@seyi");
    expect(face?.kind).toBe("photo");
    expect((await peopleAs(f, f.seyi)).me?.uploaded).toBe(true);

    await asUser(f.t, f.seyi).mutation(api.functions.faces.clearMyPhoto, {});
    expect(await faceOfHandle(f, f.shay, "@seyi")).toEqual({ kind: "emoji", emoji: "🧠" });
  });

  test("replacing it deletes the old object", async () => {
    const f = await fixture();
    for (let i = 0; i < 2; i += 1) {
      await asUser(f.t, f.seyi).action(api.functions.faces.setMyPhoto, {
        bytes: PHOTO.buffer,
        contentType: "image/png",
      });
    }
    const objects = await f.t.run((ctx) => ctx.db.system.query("_storage").collect());
    expect(objects).toHaveLength(1);
  });

  test.each([
    ["a type no browser draws", PHOTO, "image/heic", "PHOTO_TYPE"],
    ["an SVG", PHOTO, "image/svg+xml", "PHOTO_TYPE"],
    ["one over the cap", new Uint8Array(WORKSPACE_ICON_MAX_BYTES + 1), "image/png", "PHOTO_TOO_LARGE"],
  ])("%s is refused before anything is stored", async (_label, bytes, contentType, code) => {
    const f = await fixture();
    const error = await captureError(() =>
      asUser(f.t, f.seyi).action(api.functions.faces.setMyPhoto, {
        bytes: (bytes as Uint8Array).buffer as ArrayBuffer,
        contentType: contentType as string,
      }),
    );
    expect(errorCode(error)).toBe(code);
    const objects = await f.t.run((ctx) => ctx.db.system.query("_storage").collect());
    expect(objects).toHaveLength(0);
  });

  test("goes with the account", async () => {
    const f = await fixture();
    await asUser(f.t, f.shay).action(api.functions.faces.setMyPhoto, {
      bytes: PHOTO.buffer,
      contentType: "image/png",
    });
    await asUser(f.t, f.shay).mutation(api.functions.account.deleteAccount, {});
    const rows = await f.t.run((ctx) => ctx.db.query("accountPhotos").collect());
    const objects = await f.t.run((ctx) => ctx.db.system.query("_storage").collect());
    expect(rows).toEqual([]);
    expect(objects).toEqual([]);
  });
});

describe("a workspace icon photo", () => {
  test("is named by leaf in the list, and read by person", async () => {
    const f = await fixture();
    const leaf = await shayWorkspacePhoto(f);
    const row = (await peopleAs(f, f.seyi)).people.find((p) => p.handle === "@shay");
    expect(row?.face).toEqual({ kind: "workspacePhoto", leaf });
    const read = await asUser(f.t, f.seyi).action(api.functions.faces.workspacePhoto, {
      person: row!.person,
    });
    expect(new Uint8Array(read.bytes)).toEqual(PHOTO);
    expect(read.contentType).toBe("image/png");
  });

  test("a stranger, and an id naming nobody, get the same not-found", async () => {
    const f = await fixture();
    await shayWorkspacePhoto(f);
    for (const person of [f.shay as string, "not-an-id"]) {
      const error = await captureError(() =>
        asUser(f.t, f.stranger).action(api.functions.faces.workspacePhoto, { person }),
      );
      expect(errorCode(error)).toBe("FILE_NOT_FOUND");
    }
  });

  test("the inner query refuses a stranger when asked directly", async () => {
    const f = await fixture();
    await shayWorkspacePhoto(f);
    expect(
      await f.t.query(internal.functions.faces.workspacePhotoSource, {
        actorUserId: f.stranger,
        person: f.shay,
      }),
    ).toBeNull();
    expect(
      await f.t.query(internal.functions.faces.workspacePhotoSource, {
        actorUserId: f.seyi,
        person: f.shay,
      }),
    ).not.toBeNull();
  });

  test("takes a person and nothing that could name an object", () => {
    // Read from the validator Convex enforces, as workspaceIcon.test.ts does.
    const exported = JSON.parse(
      (faceFunctions.workspacePhoto as unknown as { exportArgs: () => string }).exportArgs(),
    ) as { value?: Record<string, unknown> };
    expect(Object.keys(exported.value ?? {})).toEqual(["person"]);
  });
});
