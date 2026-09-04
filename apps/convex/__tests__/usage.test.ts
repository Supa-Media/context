/**
 * COUNTING WITHOUT RECORDING — `functions/usage.ts` and `POST /gateway/usage`.
 *
 * The admin dashboard needs numbers, and the cheapest way to get them is an
 * event log: one row per tool call, with the path and the query on it, joined
 * and grouped later. That is the design these tests exist to keep out. The
 * record of what somebody did in their own context already exists, in their
 * own bucket, under their control; a second copy on our side, built for our
 * dashboards, is the first non-negotiable being traded away for a chart.
 *
 * So what is asserted here is mostly about what does **not** end up stored:
 *
 *  - a metric name outside the closed vocabulary is dropped rather than
 *    written, so a caller cannot choose what the table says;
 *  - the day comes from this deployment's clock, so a caller cannot backdate
 *    activity or spread it across a window;
 *  - a row holds a name, a day, an optional workspace and an integer, and
 *    nothing a path or a query could be smuggled through;
 *  - the public mutation takes no metric and no count, because one that did
 *    would let any account write the dashboard's numbers.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are across this file.
 *
 *   `record` storing an unrecognized metric instead of skipping it     3
 *   the day taken from a caller-supplied field rather than the clock   2
 *   `markActive` inserting unconditionally (an event log by accident)  2
 *   `reportAppSession` skipping the membership check                   1
 *   the batch cap removed                                             1
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import {
  addMember,
  asUser,
  createUser,
  createWorkspace,
  gatewayPost,
  responseFingerprint,
  setupTest,
  TEST_GATEWAY_SECRET,
  type TestConvex,
} from "./fixtures.helpers";
import { MAX_BATCH_EVENTS, MAX_EVENT_COUNT } from "../functions/usage";
import { dayKey } from "../functions/lib/usage";

async function counters(t: TestConvex) {
  return await t.run(async (ctx) => await ctx.db.query("usageDaily").collect());
}

/** A context with an owner, for tests that only need "some workspace". */
async function newWorkspace(t: TestConvex, slug: string) {
  const owner = await createUser(t, `${slug}-owner@example.com`);
  return await createWorkspace(t, owner, slug);
}

async function activeRows(t: TestConvex) {
  return await t.run(
    async (ctx) => await ctx.db.query("usageActiveDaily").collect(),
  );
}

describe("what a counter may hold", () => {
  test("a recognized metric increments one row per day", async () => {
    const t = setupTest();
    const ws = await newWorkspace(t, "alpha");

    await t.mutation(internal.functions.usage.record, {
      events: [{ metric: "mcp.tool_call", workspaceId: ws, count: 3 }],
      surface: "mcp",
    });
    await t.mutation(internal.functions.usage.record, {
      events: [{ metric: "mcp.tool_call", workspaceId: ws }],
      surface: "mcp",
    });

    const rows = await counters(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(4);
    expect(rows[0].day).toBe(dayKey(Date.now()));
  });

  test("an unrecognized metric is dropped, never stored", async () => {
    const t = setupTest();
    const result = await t.mutation(internal.functions.usage.record, {
      events: [
        { metric: "mcp.tool_call" },
        // The shapes a caller would reach for to smuggle content into the
        // table. None of them is in the vocabulary, so none of them lands.
        { metric: "search.query:how do I fix the deploy" },
        { metric: "note.read:2-areas/health/overview.md" },
        { metric: "__proto__" },
        { metric: "" },
      ],
    });
    expect(result.applied).toBe(1);

    const rows = await counters(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].metric).toBe("mcp.tool_call");
    // And nothing anywhere in the table carries the smuggled text.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("deploy");
    expect(serialized).not.toContain("overview.md");
  });

  test("a stored row has no field a path or query could occupy", async () => {
    const t = setupTest();
    const ws = await newWorkspace(t, "alpha");
    await t.mutation(internal.functions.usage.record, {
      events: [{ metric: "search.query", workspaceId: ws }],
      surface: "mcp",
    });
    const rows = await counters(t);
    // Asserted as an exact key set rather than "does not contain path",
    // because the failure mode is a *new* field arriving, and a denylist does
    // not see one.
    expect(Object.keys(rows[0]).sort()).toEqual([
      "_creationTime",
      "_id",
      "count",
      "day",
      "metric",
      "updatedAt",
      "workspaceId",
    ]);
  });

  test("the day comes from the clock, not from the caller", async () => {
    const t = setupTest();
    // `at` is the internal test seam; the HTTP route never forwards one, which
    // the route test below asserts separately. What matters here is that the
    // day is *derived*, so a remote caller has no field to set.
    await t.mutation(internal.functions.usage.record, {
      events: [{ metric: "web.visit" }],
      at: Date.parse("2020-01-02T03:04:05Z"),
    });
    const rows = await counters(t);
    expect(rows[0].day).toBe("2020-01-02");
  });

  test("counts are clamped rather than trusted", async () => {
    const t = setupTest();
    await t.mutation(internal.functions.usage.record, {
      events: [
        { metric: "web.visit", count: 10_000_000 },
        { metric: "account.signin", count: -5 },
        { metric: "account.created", count: Number.NaN },
      ],
    });
    const rows = await counters(t);
    const byMetric = new Map(rows.map((row) => [row.metric, row.count]));
    expect(byMetric.get("web.visit")).toBe(MAX_EVENT_COUNT);
    // A nonsense count is one event, not zero and not a negative that would
    // let a caller subtract from yesterday's total.
    expect(byMetric.get("account.signin")).toBe(1);
    expect(byMetric.get("account.created")).toBe(1);
  });

  test("a batch is capped", async () => {
    const t = setupTest();
    const events = Array.from({ length: MAX_BATCH_EVENTS + 25 }, () => ({
      metric: "web.visit",
    }));
    const result = await t.mutation(internal.functions.usage.record, { events });
    expect(result.applied).toBe(MAX_BATCH_EVENTS);
  });

  test("a platform-wide metric never carries a workspace", async () => {
    const t = setupTest();
    const ws = await newWorkspace(t, "alpha");
    await t.mutation(internal.functions.usage.record, {
      events: [{ metric: "web.visit", workspaceId: ws }],
      surface: "web",
    });
    const rows = await counters(t);
    // A landing-page visit attributed to a context would be a claim about who
    // that visitor was, which the visit does not support.
    expect(rows[0].workspaceId).toBeUndefined();
  });
});

describe("active contexts are a cardinality, not a log", () => {
  test("many calls in a day write one active row", async () => {
    const t = setupTest();
    const ws = await newWorkspace(t, "alpha");
    for (let i = 0; i < 25; i += 1) {
      await t.mutation(internal.functions.usage.record, {
        events: [{ metric: "mcp.tool_call", workspaceId: ws }],
        surface: "mcp",
      });
    }
    const active = await activeRows(t);
    // If this ever grows with call volume, the table has become an event log
    // with extra steps.
    expect(active).toHaveLength(1);
    expect(active[0].surface).toBe("mcp");
  });

  test("two contexts on one day are two rows, and two surfaces are two rows", async () => {
    const t = setupTest();
    const alpha = await newWorkspace(t, "alpha");
    const beta = await newWorkspace(t, "beta");
    await t.mutation(internal.functions.usage.record, {
      events: [
        { metric: "mcp.tool_call", workspaceId: alpha },
        { metric: "mcp.tool_call", workspaceId: beta },
      ],
      surface: "mcp",
    });
    await t.mutation(internal.functions.usage.record, {
      events: [{ metric: "app.session", workspaceId: alpha }],
      surface: "app",
    });
    const active = await activeRows(t);
    expect(active).toHaveLength(3);
  });

  test("the report counts distinct contexts, not calls", async () => {
    const t = setupTest();
    process.env.ADMIN_EMAILS = "staff@supa.media";
    const admin = await createUser(t, "staff@supa.media");
    const alpha = await newWorkspace(t, "alpha");
    const beta = await newWorkspace(t, "beta");

    await t.mutation(internal.functions.usage.record, {
      events: [
        { metric: "mcp.tool_call", workspaceId: alpha, count: 40 },
        { metric: "mcp.tool_call", workspaceId: beta, count: 2 },
      ],
      surface: "mcp",
    });

    const report = await t
      .withIdentity({ subject: admin })
      .query(api.functions.admin.usageReport, { days: 1 });

    const toolCalls = report.series.find((s) => s.metric === "mcp.tool_call");
    expect(toolCalls?.total).toBe(42);
    expect(report.activeContexts.distinctInWindow).toBe(2);
    expect(report.activeContexts.points.at(-1)?.count).toBe(2);
  });
});

describe("the console's own report", () => {
  test("a signed-out caller records nothing", async () => {
    const t = setupTest();
    expect(await t.mutation(api.functions.usage.reportAppSession, {})).toEqual({
      recorded: false,
    });
    expect(await counters(t)).toEqual([]);
  });

  test("a member's session marks their context active", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.com");
    const ws = await createWorkspace(t, owner, "alpha");
    const userId = await createUser(t, "member@example.com");
    await addMember(t, ws, userId, "member");

    await asUser(t, userId).mutation(api.functions.usage.reportAppSession, {
      workspaceId: ws,
    });

    const active = await activeRows(t);
    expect(active).toHaveLength(1);
    expect(active[0].workspaceId).toBe(ws);
  });

  test("a non-member cannot mark someone else's context active", async () => {
    const t = setupTest();
    const outsider = await createUser(t, "outsider@example.com");
    const ws = await newWorkspace(t, "not-theirs");

    await t
      .withIdentity({ subject: outsider })
      .mutation(api.functions.usage.reportAppSession, { workspaceId: ws });

    // The session still counts — somebody did open the app — but it is not
    // attributed to a context they are not in. Otherwise anybody could inflate
    // another tenant's activity, and "active contexts" would be a number
    // strangers write.
    const active = await activeRows(t);
    expect(active).toEqual([]);
    const rows = await counters(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].metric).toBe("app.session");
    expect(rows[0].workspaceId).toBeUndefined();
  });

  test("the public mutation has no metric or count argument", async () => {
    // A public mutation that accepted a metric name and a count would let any
    // account write the admin dashboard's figures. Convex's argument validator
    // is what stops that, so the assertion is that an extra argument is
    // *refused* rather than quietly ignored.
    const t = setupTest();
    const userId = await createUser(t, "member@example.com");
    await expect(
      asUser(t, userId).mutation(
        api.functions.usage.reportAppSession,
        { metric: "web.visit", count: 5_000 } as never,
      ),
    ).rejects.toThrow();
  });
});

describe("the gateway's reporting route", () => {
  test("it is behind the gateway secret", async () => {
    const t = setupTest();
    process.env.GATEWAY_SECRET = TEST_GATEWAY_SECRET;
    const body = { events: [{ metric: "mcp.tool_call" }] };

    const noHeader = await gatewayPost(t, "/gateway/usage", body, {
      secret: null,
    });
    const wrongSecret = await gatewayPost(t, "/gateway/usage", body, {
      secret: "not-the-secret",
    });
    expect(noHeader.status).toBe(401);
    expect(wrongSecret.status).toBe(401);
    // The same refusal for both, byte for byte — "no header" and "wrong
    // secret" are one answer everywhere else on this router and are here too.
    expect(await responseFingerprint(noHeader)).toBe(
      await responseFingerprint(wrongSecret),
    );
    expect(await counters(t)).toEqual([]);
  });

  test("an authorized report is applied", async () => {
    const t = setupTest();
    process.env.GATEWAY_SECRET = TEST_GATEWAY_SECRET;
    const ws = await newWorkspace(t, "alpha");

    const response = await gatewayPost(t, "/gateway/usage", {
      events: [
        { metric: "mcp.tool_call", workspaceId: ws, count: 2 },
        { metric: "search.query", workspaceId: ws },
      ],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: 2 });

    const rows = await counters(t);
    expect(rows).toHaveLength(2);
    // The surface is fixed by the route, not chosen by the caller.
    const active = await activeRows(t);
    expect(active).toHaveLength(1);
    expect(active[0].surface).toBe("mcp");
  });

  test("the caller cannot choose the day or the surface", async () => {
    const t = setupTest();
    process.env.GATEWAY_SECRET = TEST_GATEWAY_SECRET;
    const ws = await newWorkspace(t, "alpha");

    await gatewayPost(t, "/gateway/usage", {
      // Both are fields the mutation understands. Neither is read from the
      // body: a caller that could set `at` could backdate activity into a
      // window an operator has already looked at, and one that could set
      // `surface` could file MCP traffic as app traffic.
      at: Date.parse("2001-01-01T00:00:00Z"),
      surface: "app",
      events: [{ metric: "mcp.tool_call", workspaceId: ws }],
    });

    const rows = await counters(t);
    expect(rows[0].day).toBe(dayKey(Date.now()));
    expect((await activeRows(t))[0].surface).toBe("mcp");
  });

  test("a malformed body is answered 200 and stores nothing", async () => {
    const t = setupTest();
    process.env.GATEWAY_SECRET = TEST_GATEWAY_SECRET;

    for (const body of [
      {},
      { events: "not-an-array" },
      { events: [null, 42, "x", {}] },
      { events: [{ metric: "mcp.tool_call", workspaceId: "not-an-id" }] },
    ]) {
      const response = await gatewayPost(t, "/gateway/usage", body);
      // A counter must never be the reason a tool call is retried, so even the
      // invalid-id case — which the mutation's validator rejects — comes back
      // as a successful no-op rather than an error the gateway would surface.
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ applied: 0 });
    }
    expect(await counters(t)).toEqual([]);
  });
});
