import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { createWorkspace, gatewayPost } from "./fixtures.helpers";
import { migrate, pinnedWorld } from "./pinnedReaders.helpers";
import { bodyOf } from "./controlPlane/fixtures.helpers";
import { worldEmailOf, worldProblem } from "../functions/texLabWorld";
import { createEmulators, emulatedUrl } from "../../../packages/emulators/src/index.mjs";

/**
 * CALENDARS FOR A MADE-UP GROUP CHAT'S PEOPLE (`functions/texLabWorldCalendar.ts`; Dev2, 2026-11-27).
 *
 * A made-up person who asks for a calendar gets one on the preview's Google emulator, connected as a real connect
 * leaves it and shared with the chat, so the chat's reads run the real path: here, another person's ask reads it as
 * free and busy only. The emulator runs in process, at the URLs the control plane already calls.
 *
 * ## Sabotage record (run by hand; each must fail a test here)
 *
 *   `shareWorldCalendar` not called                     -> "... the chat reads it as free and busy" fails (no calendar here)
 *   `applyAgentGrant` skipped                          -> the same test fails (the read asks for AI access)
 *   `isIsolatedPreview` check dropped from the action  -> "refused off a preview" fails
 */

vi.setConfig({ testTimeout: 60_000 });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "lab-world-0123456789abcdef";
const KEY = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://context-emulators-pr42.example-sub.workers.dev";
const CONVEX_CLOUD = ["convex", "cloud"].join(".");
// In UTC: emulate's events list names no time zone, so a read takes the day in UTC.
const DINNER = { title: "Dinner with Mom", start: "2026-11-28T19:00:00Z", end: "2026-11-28T21:00:00Z" };

function asPreview() {
  for (const [key, value] of Object.entries({
    APP_ENV: "preview",
    PREVIEW_NAME: "pr42",
    APP_ORIGIN: "https://context-router-pr42.example-sub.workers.dev",
    CONVEX_CLOUD_URL: `https://happy-otter-123.${CONVEX_CLOUD}`,
    EMULATORS_ORIGIN: ORIGIN,
  })) vi.stubEnv(key, value);
}

/** Every Google call to the emulator, in process, as a preview's control plane sends it there. */
async function emulated() {
  const emulators = await createEmulators();
  const before = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const to = emulatedUrl(url, ORIGIN);
    if (to === null) return await before(input, init);
    return await emulators.fetch(new Request(to, { ...(init ?? {}), redirect: "manual" } as RequestInit));
  });
  return emulators;
}

async function world() {
  const w = await pinnedWorld();
  await migrate(w);
  const owner = await w.t.run(async (ctx) => (await ctx.db.query("users").first())!._id);
  for (const slug of ["lumio", "maison-solenne", "common-ground"]) await createWorkspace(w.t, owner, slug, { kind: "shared" });
  return w;
}

async function turn(t: Awaited<ReturnType<typeof world>>["t"], sender: string, participants: string[]) {
  const response = await t.fetch("/agent-texts/group", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` }, body: JSON.stringify({ line: LINE, groupId: GROUP, sender, participants, mint: true }) });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

describe("checks", () => {
  test("a calendar is only for someone on Context, with real times, and at most four a chat", () => {
    expect(worldProblem([{ name: "Sam", account: "off", calendar: { events: [] } }])).toMatch(/no calendar/);
    expect(worldProblem([{ name: "Ana", account: "on", calendar: { events: [{ title: "x", start: "soon", end: "later" }] } }])).toMatch(/ISO/);
    expect(worldProblem([{ name: "Ana", account: "on", calendar: { events: [{ ...DINNER, end: DINNER.start }] } }])).toMatch(/later end/);
    const five = ["A", "B", "C", "D", "E"].map((name) => ({ name, account: "on" as const, calendar: { events: [] } }));
    expect(worldProblem(five)).toMatch(/at most 4/);
    expect(worldProblem([{ name: "Ana", account: "on", calendar: { events: [DINNER] } }])).toBeNull();
  });
});

describe("a made-up person's calendar", () => {
  test("is connected on the emulator, shared with the chat, and the chat reads it as free and busy", async () => {
    const w = await world();
    asPreview();
    const emulators = await emulated();
    try {
      const made = (await w.t.mutation(internal.functions.texLabWorld.makeWorld, { key: KEY, line: LINE, groupId: GROUP, people: [{ name: "Ana", account: "on", calendar: { events: [DINNER] } }, { name: "Ben", account: "on" }] as never })) as { status: string; groupKey: string; made: boolean; people: { phone: string; handle: string }[] };
      expect(made).toMatchObject({ status: "ok", made: true });
      const wired = await w.t.action(internal.functions.texLabWorldCalendar.wireWorldCalendars, { groupKey: made.groupKey, people: [{ email: worldEmailOf(KEY, "Ana"), calendar: { events: [DINNER] } }] });
      expect(wired).toEqual([{ address: "beta@supa.media" }]);
      const phones = [made.people[0].phone, made.people[1].phone, LINE];
      expect(await turn(w.t, made.people[0].phone, phones)).toMatchObject({ status: "ready" });
      const ben = await turn(w.t, made.people[1].phone, phones);
      expect(ben.calendar).toEqual([{ handle: made.people[0].handle, address: "beta@supa.media" }]);
      const answer = (await bodyOf(await gatewayPost(w.t, "/gateway/calendar/days", { accessToken: ben.accessToken, expectedWorkspaceId: w.pinned, date: "2026-11-28", days: 1 }))) as { ok: boolean; days?: { text: string }[] };
      expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true });
      const text = (answer.days ?? []).map((d) => d.text).join("\n");
      expect(text).toContain("free_busy_only");
      expect(text).toMatch(/"busy":\[\{"from"/);
      expect(text).not.toContain("Dinner with Mom");
    } finally {
      await emulators.close();
    }
  });

  test("refused off a preview, making nothing", async () => {
    const w = await world();
    const wired = await w.t.action(internal.functions.texLabWorldCalendar.wireWorldCalendars, { groupKey: "k", people: [{ email: worldEmailOf(KEY, "Ana"), calendar: { events: [DINNER] } }] });
    expect(wired[0].error).toMatch(/preview/);
    expect(await w.t.run(async (ctx) => (await ctx.db.query("googleConnections").collect()).length)).toBe(0);
  });
});
