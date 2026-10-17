import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ABOUT_ME_PATH, FIRST_LOOK_AFTER_LINK_MS } from "../functions/lib/dreams/firstLook";
import { asUser, createUser, createWorkspace, setupTest } from "./fixtures.helpers";

/**
 * A FIRST LOOK FOR EVERYONE TEX TEXTS WITH WHO HAS NO ABOUT-ME (owner, 2026-10-17).
 *
 * "Some users do not have an about me and a first look at their workspaces."
 * Their first dream had found nothing to write and still counted as dreamed,
 * so nothing dreamed again until they texted. The hourly sweep makes a dream
 * due now for them, once each, and never for someone whose note exists.
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted (2026-10-17).
 *
 *   `armFirstLooksHandler` not asking the tree for the note
 *     → "someone whose note exists is left alone" fails
 *   `armFirstLooksHandler` not checking `firstLookAt`
 *     → "it happens once" fails
 *   `armFirstLooksHandler` not waiting a day after the link
 *     → "a phone linked today is left to onboarding" fails
 */

vi.setConfig({ testTimeout: 20_000 });

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const PHONE = "+15555550101";

type T = ReturnType<typeof setupTest>;

afterEach(() => {
  vi.useRealTimers();
});

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
}

async function linked(t: T, slug = "ada") {
  const userId = await createUser(t, `${slug}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, slug, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone: PHONE });
  await agentPost(t, "/agent-texts/link", { phone: PHONE, code });
  return { userId, workspaceId };
}

async function row(t: T, userId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db
      .query("texDreams")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first(),
  );
}

async function aboutMe(t: T, workspaceId: Id<"workspaces">, goneAt?: number) {
  await t.run((ctx) =>
    ctx.db.insert("nodes", { workspaceId, path: ABOUT_ME_PATH, name: "about-me.md", kind: "file", observedAt: 1, ...(goneAt ? { goneAt } : {}) }),
  );
}

/** A day and a bit after the phone was linked. */
function aDayLater() {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  vi.setSystemTime(Date.now() + FIRST_LOOK_AFTER_LINK_MS + 60_000);
}

const sweep = (t: T) => t.mutation(internal.functions.dreams.armFirstLooks, {});

describe("a first look", () => {
  test("someone with no note and a dream that already ran gets one now", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await linked(t);
    // Their first dream wrote nothing and counted as dreamed: nothing armed.
    await t.run((ctx) =>
      ctx.db.insert("texDreams", { userId, workspaceId, nextDreamAt: null, lastDreamedAt: 1, lastOutcome: "unchanged", updatedAt: 1 }),
    );
    aDayLater();
    expect(await sweep(t)).toBe(1);
    const armed = await row(t, userId);
    expect(armed!.nextDreamAt!).toBeLessThanOrEqual(Date.now());
    expect(armed!.firstLookAt).toBe(armed!.nextDreamAt);
  });

  test("someone with no row at all gets one too", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    aDayLater();
    expect(await sweep(t)).toBe(1);
    expect((await row(t, userId))!.nextDreamAt!).toBeLessThanOrEqual(Date.now());
  });

  test("someone whose note exists is left alone, and a deleted note counts as none", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await linked(t);
    await aboutMe(t, workspaceId);
    aDayLater();
    expect(await sweep(t)).toBe(0);
    expect(await row(t, userId)).toBeNull();

    const other = setupTest();
    const gone = await linked(other, "bea");
    await aboutMe(other, gone.workspaceId, 5);
    vi.setSystemTime(Date.now() + FIRST_LOOK_AFTER_LINK_MS + 60_000);
    expect(await sweep(other)).toBe(1);
  });

  test("it happens once", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    aDayLater();
    expect(await sweep(t)).toBe(1);
    const armed = await row(t, userId);
    // The dream ran and still wrote nothing.
    await t.run((ctx) => ctx.db.patch(armed!._id, { nextDreamAt: null, lastOutcome: "unchanged" }));
    expect(await sweep(t)).toBe(0);
  });

  test("a dream already armed is left to do the look itself", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await linked(t);
    const tonight = Date.now() + 60 * 60 * 1000 + FIRST_LOOK_AFTER_LINK_MS * 2;
    await t.run((ctx) => ctx.db.insert("texDreams", { userId, workspaceId, nextDreamAt: tonight, updatedAt: 1 }));
    aDayLater();
    expect(await sweep(t)).toBe(0);
    expect((await row(t, userId))!.nextDreamAt).toBe(tonight);
  });

  test("a phone linked today is left to onboarding", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    expect(await sweep(t)).toBe(0);
    expect(await row(t, userId)).toBeNull();
  });
});
