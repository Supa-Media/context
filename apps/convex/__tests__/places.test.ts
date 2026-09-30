/**
 * PLACES — what one person pinned to Home, and which folders they open most.
 *
 * Decided by the owner, 2026-09-30: the phone's Home shows the same Pinned
 * tiles and "You open most" rail on every device, so both live on the account.
 * They hold paths and counts, never note text, and they are nobody's business
 * but the person who made them.
 *
 *  1. **Only the caller's own rows,** read and written. A signed-out caller
 *     reads nothing; nobody reads another person's pins or opens.
 *  2. **Only workspaces the caller is in,** refused exactly like one that does
 *     not exist, with nothing written.
 *  3. **Only real paths.** `..`, control characters and empty strings are
 *     refused; a trailing slash is the same folder.
 *  4. **Pinning is idempotent and ordered,** new pins go last, and a reorder
 *     is exactly the order asked for. There is a ceiling per workspace.
 *  5. **Opens are a 14-day window,** counted per day, older days forgotten, a
 *     ceiling of rows per person per workspace with the stalest evicted.
 *  6. **Places follow a move** made through the app, a folder's children with
 *     it, without catching a sibling that merely shares a prefix (`Clients-old`
 *     sorts inside the index range a move reads, so the filter is what holds), and for
 *     every member — and only in that workspace.
 *  7. **They leave** with the account, with the workspace, and with the
 *     person when they leave or are removed.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   listPins filters by workspace only (every member's pins)         2
 *   pin skips the membership check                                   2
 *   pin inserts a second row for the same path                       2
 *   reorderPins ignores the order given                              1
 *   no ceiling on pins                                               1
 *   recordOpen never drops days outside the window                   1
 *   no ceiling on open rows                                          1
 *   retarget uses startsWith(from) without the slash                 1
 *   no sweep on leaveWorkspace                                       1
 *   retarget left out of moveEntry                                   1
 *   no sweep on removeMember                                         1
 *   no sweep on account deletion                                     1
 *   no sweep on workspace deletion                                   1
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  addMember,
  asUser,
  createUser,
  createWorkspace,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

const listPins = api.functions.places.listPins;
const pin = api.functions.places.pin;
const unpin = api.functions.places.unpin;
const reorderPins = api.functions.places.reorderPins;
const recordOpen = api.functions.places.recordOpen;
const mostOpened = api.functions.places.mostOpened;
const retarget = internal.functions.places.retargetPlaces;

const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function world() {
  const t = setupTest();
  const seyi = await createUser(t, "seyi@example.invalid");
  const jon = await createUser(t, "jon@example.invalid");
  const ws = await createWorkspace(t, seyi, "northwind", { kind: "shared" });
  await addMember(t, ws, jon, "member", seyi);
  return { t, seyi, jon, ws };
}

const allPins = (t: TestConvex) => t.run((ctx) => ctx.db.query("placePins").collect());
const allOpens = (t: TestConvex) => t.run((ctx) => ctx.db.query("placeOpens").collect());

describe("pins", () => {
  test("signed out reads nothing", async () => {
    const { t, ws } = await world();
    expect(await t.query(listPins, { workspaceId: ws })).toEqual([]);
  });

  test("a pin is the pinner's alone, and goes last", async () => {
    const { t, seyi, jon, ws } = await world();
    const me = asUser(t, seyi);
    await me.mutation(pin, { workspaceId: ws, path: "Clients", kind: "folder" });
    await me.mutation(pin, { workspaceId: ws, path: "Projects/Launch plan.md", kind: "note" });
    expect((await me.query(listPins, { workspaceId: ws })).map((p) => [p.path, p.kind])).toEqual([
      ["Clients", "folder"],
      ["Projects/Launch plan.md", "note"],
    ]);
    // Jon sees his own Home, not Seyi's.
    expect(await asUser(t, jon).query(listPins, { workspaceId: ws })).toEqual([]);
    await asUser(t, jon).mutation(pin, { workspaceId: ws, path: "Brand", kind: "folder" });
    expect((await me.query(listPins, { workspaceId: ws })).map((p) => p.path)).toEqual([
      "Clients",
      "Projects/Launch plan.md",
    ]);
  });

  test("pinning twice keeps one row; a trailing slash is the same folder", async () => {
    const { t, seyi, ws } = await world();
    const me = asUser(t, seyi);
    await me.mutation(pin, { workspaceId: ws, path: "Clients", kind: "folder" });
    await me.mutation(pin, { workspaceId: ws, path: "Clients/", kind: "folder" });
    expect(await allPins(t)).toHaveLength(1);
  });

  test("unpin removes only that pin", async () => {
    const { t, seyi, ws } = await world();
    const me = asUser(t, seyi);
    await me.mutation(pin, { workspaceId: ws, path: "Clients", kind: "folder" });
    await me.mutation(pin, { workspaceId: ws, path: "Brand", kind: "folder" });
    await me.mutation(unpin, { workspaceId: ws, path: "Clients" });
    expect((await me.query(listPins, { workspaceId: ws })).map((p) => p.path)).toEqual(["Brand"]);
    // Unpinning something that is not pinned is not an error.
    await me.mutation(unpin, { workspaceId: ws, path: "Nowhere" });
  });

  test("reorder is exactly the order asked for", async () => {
    const { t, seyi, ws } = await world();
    const me = asUser(t, seyi);
    for (const path of ["A", "B", "C"]) await me.mutation(pin, { workspaceId: ws, path, kind: "folder" });
    await me.mutation(reorderPins, { workspaceId: ws, paths: ["C", "A", "B"] });
    expect((await me.query(listPins, { workspaceId: ws })).map((p) => p.path)).toEqual(["C", "A", "B"]);
    // A partial list moves what it names to the front and keeps the rest after.
    await me.mutation(reorderPins, { workspaceId: ws, paths: ["B"] });
    expect((await me.query(listPins, { workspaceId: ws })).map((p) => p.path)).toEqual(["B", "C", "A"]);
  });

  test("a workspace the caller is not in is refused and nothing is written", async () => {
    const { t, ws } = await world();
    const stranger = await createUser(t, "stranger@example.invalid");
    await expect(
      asUser(t, stranger).mutation(pin, { workspaceId: ws, path: "Clients", kind: "folder" }),
    ).rejects.toThrow();
    await expect(asUser(t, stranger).query(listPins, { workspaceId: ws })).rejects.toThrow();
    expect(await allPins(t)).toEqual([]);
  });

  test("a path that is not a path is refused", async () => {
    const { t, seyi, ws } = await world();
    const me = asUser(t, seyi);
    for (const path of ["", "/", "../x", "a/../b", "a\nb"]) {
      await expect(me.mutation(pin, { workspaceId: ws, path, kind: "folder" })).rejects.toThrow();
    }
    expect(await allPins(t)).toEqual([]);
  });

  test("there is a ceiling on pins in one workspace", async () => {
    const { t, seyi, ws } = await world();
    const me = asUser(t, seyi);
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i++) {
        await ctx.db.insert("placePins", {
          userId: seyi,
          workspaceId: ws,
          path: `n${i}.md`,
          kind: "note",
          order: i,
          pinnedAt: i,
        });
      }
    });
    await expect(me.mutation(pin, { workspaceId: ws, path: "one-more.md", kind: "note" })).rejects.toThrow();
    // Re-pinning something already pinned is still fine at the ceiling.
    await me.mutation(pin, { workspaceId: ws, path: "n3.md", kind: "note" });
    expect(await allPins(t)).toHaveLength(60);
  });
});

describe("opens", () => {
  test("counts per folder over the last 14 days, busiest first", async () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 8, 1, 12);
    vi.setSystemTime(start);
    const { t, seyi, ws } = await world();
    const me = asUser(t, seyi);
    for (let i = 0; i < 3; i++) await me.mutation(recordOpen, { workspaceId: ws, path: "Meetings" });
    await me.mutation(recordOpen, { workspaceId: ws, path: "Projects" });
    vi.setSystemTime(start + DAY);
    await me.mutation(recordOpen, { workspaceId: ws, path: "Projects" });
    await me.mutation(recordOpen, { workspaceId: ws, path: "Projects" });
    await me.mutation(recordOpen, { workspaceId: ws, path: "Projects/" });

    const rows = await me.query(mostOpened, { workspaceId: ws });
    expect(rows.map((r) => [r.path, r.opens, r.daysOpened])).toEqual([
      ["Projects", 4, 2],
      ["Meetings", 3, 1],
    ]);
  });

  test("days older than the window are forgotten", async () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 8, 1, 12);
    vi.setSystemTime(start);
    const { t, seyi, ws } = await world();
    const me = asUser(t, seyi);
    for (let i = 0; i < 5; i++) await me.mutation(recordOpen, { workspaceId: ws, path: "Old" });
    vi.setSystemTime(start + 20 * DAY);
    await me.mutation(recordOpen, { workspaceId: ws, path: "New" });
    expect((await me.query(mostOpened, { workspaceId: ws })).map((r) => r.path)).toEqual(["New"]);
    // And the next write to the old row drops the stale days from storage too.
    await me.mutation(recordOpen, { workspaceId: ws, path: "Old" });
    const old = (await allOpens(t)).find((row) => row.path === "Old")!;
    expect(old.days).toEqual([{ day: Math.floor((start + 20 * DAY) / DAY), n: 1 }]);
  });

  test("opens are the opener's alone", async () => {
    const { t, seyi, jon, ws } = await world();
    await asUser(t, seyi).mutation(recordOpen, { workspaceId: ws, path: "Clients" });
    expect(await asUser(t, jon).query(mostOpened, { workspaceId: ws })).toEqual([]);
    expect(await t.query(mostOpened, { workspaceId: ws })).toEqual([]);
  });

  test("a workspace the caller is not in is refused and nothing is written", async () => {
    const { t, ws } = await world();
    const stranger = await createUser(t, "stranger@example.invalid");
    await expect(asUser(t, stranger).mutation(recordOpen, { workspaceId: ws, path: "Clients" })).rejects.toThrow();
    expect(await allOpens(t)).toEqual([]);
  });

  test("the stalest row makes room at the ceiling", async () => {
    const { t, seyi, ws } = await world();
    const today = Math.floor(Date.now() / DAY);
    await t.run(async (ctx) => {
      for (let i = 0; i < 300; i++) {
        await ctx.db.insert("placeOpens", {
          userId: seyi,
          workspaceId: ws,
          path: `f${i}`,
          days: [{ day: today, n: 1 }],
          lastAt: 1000 + i,
        });
      }
    });
    await asUser(t, seyi).mutation(recordOpen, { workspaceId: ws, path: "fresh" });
    const paths = (await allOpens(t)).map((row) => row.path);
    expect(paths).toHaveLength(300);
    expect(paths).toContain("fresh");
    expect(paths).not.toContain("f0");
  });
});

describe("places follow a move", () => {
  test("exact paths and everything under a folder, for every member, in that workspace only", async () => {
    const { t, seyi, jon, ws } = await world();
    const other = await createWorkspace(t, seyi, "elsewhere");
    await asUser(t, seyi).mutation(pin, { workspaceId: ws, path: "Clients", kind: "folder" });
    await asUser(t, seyi).mutation(pin, { workspaceId: ws, path: "Clients/Acme/brief.md", kind: "note" });
    await asUser(t, seyi).mutation(pin, { workspaceId: ws, path: "Clients-old", kind: "folder" });
    await asUser(t, seyi).mutation(pin, { workspaceId: other, path: "Clients", kind: "folder" });
    await asUser(t, jon).mutation(recordOpen, { workspaceId: ws, path: "Clients/Acme" });

    await t.mutation(retarget, { workspaceId: ws, from: "Clients", to: "Work/Clients" });

    expect((await asUser(t, seyi).query(listPins, { workspaceId: ws })).map((p) => p.path)).toEqual([
      "Work/Clients",
      "Work/Clients/Acme/brief.md",
      "Clients-old",
    ]);
    expect((await asUser(t, seyi).query(listPins, { workspaceId: other })).map((p) => p.path)).toEqual([
      "Clients",
    ]);
    expect((await asUser(t, jon).query(mostOpened, { workspaceId: ws })).map((r) => r.path)).toEqual([
      "Work/Clients/Acme",
    ]);
  });

  test("landing on a place already there merges rather than duplicating", async () => {
    const { t, seyi, ws } = await world();
    const me = asUser(t, seyi);
    await me.mutation(pin, { workspaceId: ws, path: "A", kind: "folder" });
    await me.mutation(pin, { workspaceId: ws, path: "B", kind: "folder" });
    await me.mutation(recordOpen, { workspaceId: ws, path: "A" });
    await me.mutation(recordOpen, { workspaceId: ws, path: "B" });
    await t.mutation(retarget, { workspaceId: ws, from: "A", to: "B" });
    expect((await me.query(listPins, { workspaceId: ws })).map((p) => p.path)).toEqual(["B"]);
    expect((await me.query(mostOpened, { workspaceId: ws })).map((r) => [r.path, r.opens])).toEqual([["B", 2]]);
  });

  test("a rename through the app carries the pin with it", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");
    const backend = memoryS3(FAKE_STORAGE.bucket);
    backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
    backend.seed("index.md", "# Context\n");
    backend.seed("1-projects/clients/brief.md", "# Brief\n");
    vi.stubGlobal("fetch", backend.fetchImpl);
    const encryptedSecretAccessKey = await encryptSecret(FAKE_STORAGE.secretAccessKey, requireKeyset(), {
      workspaceId,
    });
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
    const me = asUser(t, owner);
    await me.mutation(pin, { workspaceId, path: "1-projects/clients", kind: "folder" });
    await me.action(api.functions.files.moveEntry, {
      workspaceId,
      from: "1-projects/clients",
      to: "1-projects/client-work",
    });
    expect((await me.query(listPins, { workspaceId })).map((p) => p.path)).toEqual(["1-projects/client-work"]);
  });
});

describe("places leave with their person", () => {
  test("removed from the workspace: that person's places go, everyone else's stay", async () => {
    const { t, seyi, jon, ws } = await world();
    await asUser(t, jon).mutation(pin, { workspaceId: ws, path: "Clients", kind: "folder" });
    await asUser(t, jon).mutation(recordOpen, { workspaceId: ws, path: "Clients" });
    await asUser(t, seyi).mutation(pin, { workspaceId: ws, path: "Brand", kind: "folder" });
    await asUser(t, seyi).mutation(api.functions.workspaces.removeMember, { workspaceId: ws, userId: jon });
    expect((await allPins(t)).map((row) => row.userId)).toEqual([seyi]);
    expect(await allOpens(t)).toEqual([]);
  });

  test("leaving takes them too", async () => {
    const { t, jon, ws } = await world();
    await asUser(t, jon).mutation(pin, { workspaceId: ws, path: "Clients", kind: "folder" });
    await asUser(t, jon).mutation(api.functions.workspaces.leaveWorkspace, { workspaceId: ws });
    expect(await allPins(t)).toEqual([]);
  });

  test("deleting the account takes every place of theirs", async () => {
    const { t, jon, ws } = await world();
    await asUser(t, jon).mutation(pin, { workspaceId: ws, path: "Clients", kind: "folder" });
    await asUser(t, jon).mutation(recordOpen, { workspaceId: ws, path: "Clients" });
    await asUser(t, jon).mutation(api.functions.account.deleteAccount, {});
    expect(await allPins(t)).toEqual([]);
    expect(await allOpens(t)).toEqual([]);
  });

  test("deleting the workspace takes every member's places in it", async () => {
    const { t, seyi, jon, ws } = await world();
    await asUser(t, jon).mutation(pin, { workspaceId: ws, path: "Clients", kind: "folder" });
    await asUser(t, seyi).mutation(recordOpen, { workspaceId: ws, path: "Clients" });
    await asUser(t, seyi).mutation(api.functions.account.deleteWorkspace, {
      workspaceId: ws,
      confirmSlug: "northwind",
    });
    expect(await allPins(t)).toEqual([]);
    expect(await allOpens(t)).toEqual([]);
  });
});

export type { Id };
