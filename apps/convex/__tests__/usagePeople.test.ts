import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { insertTurn } from "../functions/lib/agentTurnMark";
import { dayKey } from "../functions/lib/usage";
import { callsOf, repliesOf, timingQueries, usageTimings } from "../functions/lib/usagePeopleTimings";
import { MAX_PEOPLE_PER_REPORT, PEOPLE_RETENTION_DAYS, peopleMarks } from "../functions/usagePeople";
import { createUser, createWorkspace, gatewayPost, seedGrant, setupTest, TEST_GATEWAY_SECRET } from "./fixtures.helpers";

/**
 * THE CONTEXT USAGE SOURCE's control-plane half (`functions/usagePeople.ts`, `POST /gateway/usage` `people`,
 * `POST /gateway/usage/export`). One row per person per day, keyed by the gateway's MAC, never an account id.
 *
 * Sabotage record (temporary local edits, reverted):
 * 1. `mark` inserting on every call: "a person is one row a day, however often they are marked" fails.
 * 2. `peopleMarks` accepting any string as a person: "a person is a 16-hex MAC" fails.
 * 3. `exportRows` keeping group turns: "only a person's own 1:1 texts count as texting" fails.
 * 4. The export route built with no gateway check: "the export is the gateway's alone" fails.
 * 5. `exportRows` keeping content reports: "bug reports are the sent ones, by reference and channel" fails.
 */

const P1 = "0123456789abcdef";
const P2 = "fedcba9876543210";
const DAY = 86_400_000;

function turn(workspaceId: Id<"workspaces">, grantId: Id<"oauthGrants">, at: number, kind: "one" | "group" | "job", outcome: "answered" | "failed" = "answered") {
  return {
    workspaceId,
    grantId,
    client: "texts" as const,
    kind,
    provider: "builtin",
    model: "fake-model",
    outcome,
    at,
    ms: 1000,
    modelMs: 600,
    toolMs: 400,
    rounds: 1,
    inputTokens: 1,
    outputTokens: 1,
    trace: [{ kind: "model" as const, ok: true, ms: 600 }],
  };
}

describe("people marks", () => {
  test("a person is a 16-hex MAC and a kind is wrote or called; anything else is dropped", () => {
    expect(peopleMarks([{ person: P1, kind: "wrote" }, { person: P1, kind: "wrote" }, { person: P2, kind: "called" }])).toEqual([
      { person: P1, kind: "wrote" },
      { person: P2, kind: "called" },
    ]);
    for (const bad of [{ person: "user_123", kind: "wrote" }, { person: P1.toUpperCase(), kind: "wrote" }, { person: P1, kind: "texted" }, { person: P1, kind: "__proto__" }, null, "x"]) {
      expect(peopleMarks([bad])).toEqual([]);
    }
    expect(peopleMarks("nope")).toEqual([]);
    const many = Array.from({ length: MAX_PEOPLE_PER_REPORT + 10 }, (_, i) => ({ person: i.toString(16).padStart(16, "0"), kind: "called" }));
    expect(peopleMarks(many)).toHaveLength(MAX_PEOPLE_PER_REPORT);
  });

  test("a person is one row a day, however often they are marked, with both flags", async () => {
    const t = setupTest();
    const at = Date.parse("2026-11-25T10:00:00Z");
    await t.mutation(internal.functions.usagePeople.mark, { people: [{ person: P1, kind: "called" }], at });
    await t.mutation(internal.functions.usagePeople.mark, { people: [{ person: P1, kind: "called" }], at: at + 1000 });
    await t.mutation(internal.functions.usagePeople.mark, { people: [{ person: P1, kind: "wrote" }], at: at + 2000 });
    await t.mutation(internal.functions.usagePeople.mark, { people: [{ person: P1, kind: "wrote" }], at: at + DAY });
    const rows = await t.run((ctx) => ctx.db.query("usagePeopleDaily").collect());
    expect(rows.map(({ day, person, wrote, called }) => ({ day, person, wrote, called }))).toEqual([
      { day: "2026-11-25", person: P1, wrote: true, called: true },
      { day: "2026-11-26", person: P1, wrote: true, called: undefined },
    ]);
    // Exactly the kept keys: nothing a path, a tool or an account could sit in.
    expect(Object.keys(rows[0]).sort()).toEqual(["_creationTime", "_id", "at", "called", "day", "person", "wrote"]);
  });

  test("person-days past their retention are pruned", async () => {
    const t = setupTest();
    const now = Date.parse("2026-11-25T10:00:00Z");
    await t.mutation(internal.functions.usagePeople.mark, { people: [{ person: P1, kind: "called" }], at: now - (PEOPLE_RETENTION_DAYS + 2) * DAY });
    await t.mutation(internal.functions.usagePeople.mark, { people: [{ person: P2, kind: "called" }], at: now - DAY });
    await t.mutation(internal.functions.usagePeople.prune, { at: now });
    const rows = await t.run((ctx) => ctx.db.query("usagePeopleDaily").collect());
    expect(rows.map((row) => row.person)).toEqual([P2]);
  });

  test("POST /gateway/usage carries people marks, and the day is the deployment's", async () => {
    const t = setupTest();
    const response = await gatewayPost(t, "/gateway/usage", { people: [{ person: P1, kind: "called", day: "2020-01-01" }, { person: "not-a-mac", kind: "called" }] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: 1 });
    const rows = await t.run((ctx) => ctx.db.query("usagePeopleDaily").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].day).toBe(dayKey(Date.now()));
  });
});

describe("the export", () => {
  test("only a person's own 1:1 texts count as texting, by their personal workspace's owner", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    const own = await createWorkspace(t, ada, "ada", { kind: "personal" });
    const team = await createWorkspace(t, ada, "crew-ada", { kind: "shared" });
    const grant = await seedGrant(t, own, ada, "context_texts", "hash-ada");
    const teamGrant = await seedGrant(t, team, ada, "context_texts", "hash-team");
    const now = Date.now();
    await t.run(async (ctx) => {
      await insertTurn(ctx, turn(own, grant, now - 3000, "one"));
      await insertTurn(ctx, turn(own, grant, now - 2000, "one", "failed"));
      await insertTurn(ctx, turn(own, grant, now - 1000, "group"));
      await insertTurn(ctx, turn(own, grant, now - 500, "job"));
      await insertTurn(ctx, turn(team, teamGrant, now - 400, "one"));
    });
    const out = await t.query(internal.functions.usagePeople.exportRows, { since: now - DAY });
    expect(out.texts).toEqual([
      { at: now - 3000, userId: ada, outcome: "answered" },
      { at: now - 2000, userId: ada, outcome: "failed" },
    ]);
    expect(out.signups.map((row: { userId: string }) => row.userId)).toEqual([ada]);
    expect(out.cut).toBe(false);
  });

  test("bug reports are the sent ones, by reference and channel, never a report about content or one still sending", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    const now = Date.now();
    const receipt = (n: number, extra: Record<string, unknown>) => ({ userId: ada, clientReportId: `c${n}`, eventId: String(n).repeat(32), state: "sent" as const, createdAt: now - n * 1000, ...extra });
    await t.run(async (ctx) => {
      await ctx.db.insert("feedbackReceipts", receipt(1, { channel: "tex" }));
      await ctx.db.insert("feedbackReceipts", receipt(2, { channel: "app" }));
      await ctx.db.insert("feedbackReceipts", receipt(3, { channel: "content" }));
      await ctx.db.insert("feedbackReceipts", receipt(4, { channel: "agent", state: "sending" }));
      await ctx.db.insert("feedbackReceipts", receipt(5, {}));
      await ctx.db.insert("feedbackReceipts", receipt(6, { channel: "tex-group", createdAt: now - 10 * DAY }));
    });
    const out = await t.query(internal.functions.usagePeople.exportRows, { since: now - DAY });
    expect(out.bugs).toEqual([
      { at: now - 2000, userId: ada, channel: "app", reference: "2".repeat(32) },
      { at: now - 1000, userId: ada, channel: "tex", reference: "1".repeat(32) },
    ]);
    // The bug sheet's own first run reaches back further than the others'.
    const back = await t.query(internal.functions.usagePeople.exportRows, { since: now - DAY, bugsSince: now - 30 * DAY });
    expect(back.bugs.map((row: { channel: string }) => row.channel)).toEqual(["tex-group", "app", "tex"]);
  });

  test("the export is the gateway's alone", async () => {
    const t = setupTest();
    for (const secret of [null, `${TEST_GATEWAY_SECRET}x`]) {
      const response = await gatewayPost(t, "/gateway/usage/export", { since: 0 }, { secret });
      expect(response.status).toBe(401);
    }
    const ok = await gatewayPost(t, "/gateway/usage/export", { since: 0 });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(Object.keys(body).sort()).toEqual(["activity", "bugs", "calls", "cut", "replies", "signups", "texts", "timingsError", "vitals"]);
    expect(body.calls).toEqual([]);
    expect(typeof body.timingsError).toBe("string");
  });
});

describe("the timings, from Analytics Engine", () => {
  test("the queries are built from a number and this deployment's datasets", () => {
    const q = timingQueries({ calls: "mcp_entry_staging", replies: "tex_text_timing_staging" }, 1_764_000_000_123);
    expect(q.calls).toContain("FROM mcp_entry_staging");
    expect(q.calls).toContain("toDateTime(1764000000)");
    expect(q.replies).toContain("FROM tex_text_timing_staging");
  });

  test("rows not shaped as the gateway writes them are dropped", () => {
    expect(
      callsOf([
        { timestamp: "2026-11-25 05:00:00", call: "tools/call:orient", state: "ok", client: "Claude", ms: "546.4", weight: "3" },
        { timestamp: "2026-11-25 05:00:01", call: "tools/call:write:remember", state: "failed", client: "<b>x</b>", ms: 90, weight: 0 },
        { timestamp: "2026-11-25 05:00:02", call: "tools/call:DROP TABLE", state: "ok", client: "", ms: 1, weight: 1 },
        { timestamp: "nope", call: "tools/call:fetch", state: "ok", client: "", ms: 1, weight: 1 },
      ]),
    ).toEqual([
      { at: Date.parse("2026-11-25T05:00:00Z"), tool: "orient", ms: 546, ok: true, client: "Claude", weight: 3 },
      { at: Date.parse("2026-11-25T05:00:01Z"), tool: "write:remember", ms: 90, ok: false, client: "", weight: 1 },
    ]);
    expect(repliesOf([{ timestamp: "2026-11-25 05:00:00", kind: "one", first: 12271 }, { timestamp: "2026-11-25 05:00:00", kind: "x", first: 1 }])).toEqual([
      { at: Date.parse("2026-11-25T05:00:00Z"), kind: "one", seconds: 12.3 },
    ]);
  });

  test("a failed read says so and returns nothing", async () => {
    const env = { CLOUDFLARE_ANALYTICS_TOKEN: "t", CLOUDFLARE_ANALYTICS_ACCOUNT_ID: "0".repeat(32) };
    const down = await usageTimings(env, 0, (async () => new Response("no", { status: 403 })) as typeof fetch);
    expect(down).toEqual({ calls: [], replies: [], error: "Cloudflare answered 403" });
  });
});
