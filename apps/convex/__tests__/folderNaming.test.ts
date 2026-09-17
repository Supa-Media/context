/**
 * SHARING A FOLDER WITH A GROUP OR A PERSON.
 *
 * The bug this file starts from is the one an owner hit in the console: open a
 * folder, press Share, pick a group, and be told
 *
 *   "Only markdown notes can have their own visibility. Set the folder's
 *    default instead."
 *
 * — advice that names the right instrument and cannot be followed, because the
 * control that sets a folder's default takes the two tiers and has no way to
 * say a group. `shareWithGroup` in the console called `setNoteGroup` for
 * everything, and `setNoteGroup` runs `fileOps.setVisibility`, which refuses a
 * path that is not `.md`.
 *
 * Nothing in the engine was in the way: `setFolderVisibility` has taken a
 * `Visibility` — and a group is one — since the group namespace existed. Only
 * the route was missing.
 *
 * ## The half of this that is a decision rather than a fix
 *
 * `visibility.folder` is on `MEMBER_VISIBLE_DETAIL_ACTIONS`, and its entry
 * defends itself on the details it actually carries: "`visibility.folder` keeps
 * no `exception` field and its subject is one a member already sees first-hand
 * in their own listing." That is true while the value is `private` or `team`. A
 * member watching a folder learns its default changed the instant their own
 * listing changes, so the row tells them nothing new.
 *
 * **It stops being true the moment the value can be a name.** A member who is
 * not in `@atlas-leads` sees the folder leave their listing — they learn *that*
 * — and the row would additionally hand them the group's name, which
 * `listGroups` is owner-only to withhold, "for the reason the note census is: a
 * member who could enumerate them could work out the shape of what is being
 * kept from them".
 *
 * So the action is **split** rather than the gate being made to inspect values.
 * `visibility.folder` goes on meaning the two tiers and stays member-visible;
 * `visibility.folder.named` carries a name and is absent from the allow-list.
 * The gate stays purely per-action, which is the shape it was deliberately
 * given — a value-dependent gate would make a row's shape depend on its
 * contents, and `pathsWithheld` is computed from the reader and never the row
 * for exactly that reason.
 *
 * What a member still learns, stated rather than hidden: the row's action,
 * actor and timestamp are ungated, so "the owner pointed this folder at
 * somebody at 14:02" is visible. That is the incidence signal the decision file
 * already leaves open for every other action, and it names nobody.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  type TestConvex,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  insider: Id<"users">;
  outsider: Id<"users">;
  kola: Id<"users">;
  workspaceId: Id<"workspaces">;
  groupId: Id<"workspaceGroups">;
  groupName: string;
  backend: MemoryS3;
}

async function fixture(): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const insider = await createUser(t, "insider@example.invalid");
  const outsider = await createUser(t, "outsider@example.invalid");
  const kola = await createUser(t, "kola@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "atlas", {
    kind: "shared",
    displayName: "Atlas",
  });
  await addMember(t, workspaceId, insider, "member", owner);
  await addMember(t, workspaceId, outsider, "member", owner);
  await addMember(t, workspaceId, kola, "member", owner);
  await createWorkspace(t, kola, "kola", { kind: "personal" });

  const group = await asUser(t, owner).mutation(api.functions.groups.createGroup, {
    workspaceId,
    label: "leads",
  });
  await asUser(t, owner).mutation(api.functions.groups.addGroupMember, {
    workspaceId,
    groupId: group.groupId,
    userId: insider,
  });

  const backend = memoryS3(FAKE_STORAGE.bucket);
  // A SHARED workspace scaffolds its folders `team`, so the folder starts
  // readable by everybody — which is what makes the narrowing below visible as
  // a narrowing rather than as a folder that was never shared.
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para", [], "shared"));
  backend.seed("index.md", "# Atlas\n");
  backend.seed("2-areas/README.md", "# Areas\n");
  backend.seed("2-areas/hr.md", "# HR\n");
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
      capabilities: {
        conditionalWrite: true,
        conditionalCreate: true,
        conditionalDelete: true,
      },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  return {
    t,
    owner,
    insider,
    outsider,
    kola,
    workspaceId,
    groupId: group.groupId,
    groupName: group.name,
    backend,
  };
}

async function listing(f: Fixture, who: Id<"users">, path: string): Promise<string[]> {
  const result = await asUser(f.t, who).action(api.functions.files.listFiles, {
    workspaceId: f.workspaceId,
    path,
  });
  return result.entries.map((entry) => entry.name);
}

/* -------------------------------------------------------------------------- */
/*                        1. the folder route exists                          */
/* -------------------------------------------------------------------------- */

describe("a folder can be pointed at a group", () => {
  test("the rule lands in the manifest as the folder's default", async () => {
    const f = await fixture();
    const result = await asUser(f.t, f.owner).action(api.functions.files.setFolderGroup, {
      workspaceId: f.workspaceId,
      path: "2-areas",
      group: f.groupName,
    });
    expect(result.visibility).toBe(`@${f.groupName}`);
    expect(f.backend.snapshot()[PRIVACY_KEY]).toContain(`2-areas: @${f.groupName}`);
  });

  test("a leading @ is tolerated, because it is what the console shows", async () => {
    const f = await fixture();
    const result = await asUser(f.t, f.owner).action(api.functions.files.setFolderGroup, {
      workspaceId: f.workspaceId,
      path: "2-areas",
      group: `@${f.groupName}`,
    });
    expect(result.visibility).toBe(`@${f.groupName}`);
  });

  test("the people named can read it and the people not named cannot", async () => {
    const f = await fixture();
    // Before: a shared workspace scaffolds `team`, so both can see it.
    expect(await listing(f, f.insider, "2-areas")).toContain("hr.md");
    expect(await listing(f, f.outsider, "2-areas")).toContain("hr.md");

    await asUser(f.t, f.owner).action(api.functions.files.setFolderGroup, {
      workspaceId: f.workspaceId,
      path: "2-areas",
      group: f.groupName,
    });

    expect(await listing(f, f.insider, "2-areas")).toContain("hr.md");
    expect(await listing(f, f.outsider, "2-areas")).toEqual([]);
  });

  test("a folder can be pointed at one person by their handle", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.setFolderGroup, {
      workspaceId: f.workspaceId,
      path: "2-areas",
      group: "kola",
    });
    expect(await listing(f, f.kola, "2-areas")).toContain("hr.md");
    expect(await listing(f, f.outsider, "2-areas")).toEqual([]);
  });

  test("a name this workspace cannot resolve is refused", async () => {
    const f = await fixture();
    const refused = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.setFolderGroup, {
        workspaceId: f.workspaceId,
        path: "2-areas",
        group: "nobody-at-all",
      }),
    );
    expect(errorCode(refused)).toBe("GROUP_NOT_FOUND");
    // And nothing was written on the way to refusing.
    expect(f.backend.snapshot()[PRIVACY_KEY]).not.toContain("nobody-at-all");
  });

  test("only an owner may point a folder at anybody", async () => {
    const f = await fixture();
    const refused = await captureError(() =>
      asUser(f.t, f.insider).action(api.functions.files.setFolderGroup, {
        workspaceId: f.workspaceId,
        path: "2-areas",
        group: f.groupName,
      }),
    );
    expect(refused).toBeDefined();
    expect(f.backend.snapshot()[PRIVACY_KEY]).not.toContain(`2-areas: @${f.groupName}`);
  });
});

/* -------------------------------------------------------------------------- */
/*              2. and the name does not leak through the trail               */
/* -------------------------------------------------------------------------- */

/**
 * THE ATTACK: LEARN A GROUP'S NAME FROM THE AUDIT TRAIL.
 *
 * `listGroups` is owner-only. A member who could enumerate a context's groups
 * could work out the shape of what is being kept from them, which is the same
 * reason the note census is owner-only. A `visibility.folder` row carrying
 * `@atlas-leads` in its member-visible details would hand that back through a
 * different door.
 */
describe("a folder's named audience is not published to every member", () => {
  test("a non-owner does not get the name out of listEvents", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.setFolderGroup, {
      workspaceId: f.workspaceId,
      path: "2-areas",
      group: f.groupName,
    });

    const events = await asUser(f.t, f.outsider).query(api.functions.audit.listEvents, {
      workspaceId: f.workspaceId,
    });
    expect(JSON.stringify(events)).not.toContain(f.groupName);
  });

  test("the owner's own record keeps it", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.setFolderGroup, {
      workspaceId: f.workspaceId,
      path: "2-areas",
      group: f.groupName,
    });

    const events = await asUser(f.t, f.owner).query(api.functions.audit.listEvents, {
      workspaceId: f.workspaceId,
    });
    expect(JSON.stringify(events)).toContain(f.groupName);
  });

  /**
   * The two-tier setter is untouched, which is the point of splitting the
   * action rather than gating on the value: a member goes on seeing what they
   * saw before for the case the allow-list entry was written about.
   */
  test("an ordinary team/private folder change still shows its value to a member", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "2-areas",
      visibility: "private",
    });

    const events = await asUser(f.t, f.outsider).query(api.functions.audit.listEvents, {
      workspaceId: f.workspaceId,
    });
    const row = events.find((event) => event.action === "visibility.folder");
    expect(row?.details).toEqual({ visibility: "private" });
  });

  test("the named row is still a row, so the trail has a hole rather than a lie", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.setFolderGroup, {
      workspaceId: f.workspaceId,
      path: "2-areas",
      group: f.groupName,
    });

    const events = await asUser(f.t, f.outsider).query(api.functions.audit.listEvents, {
      workspaceId: f.workspaceId,
    });
    const row = events.find(
      (event) => event.action === "visibility.folder.named",
    );
    expect(row).toBeDefined();
    expect(row?.details).toBeUndefined();
  });
});
