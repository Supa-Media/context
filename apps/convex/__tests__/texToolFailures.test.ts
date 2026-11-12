import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { keptWhy } from "../functions/texToolFailures";
import { asUser, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";

/**
 * WHY TEX'S TOOL CALLS FAIL (Dev2, 2026-11-10): the gateway reports each
 * failed call through `/gateway/tool-failures`, the row keeps nobody, and
 * tex.lc/admin's report groups them by tool, cause and reason.
 *
 * Every value here is obviously fake. This repository is public.
 *
 * ## Sabotage record
 *
 *  1. The row keeps the grant's workspace. → "a row names nobody" fails.
 *  2. `keptWhy` without the digit rule. → "a reason loses any value the gateway left" fails.
 *  3. The report groups by tool alone. → "the report groups by tool, cause and reason" fails.
 */

const ADMIN = "staff@example.invalid";
type T = ReturnType<typeof setupTest>;

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const PHONE = "+15555550100";

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify(body),
  });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

/** Staff, and Ada texting Tex: her grant is the live connection the gateway reports under. */
async function world(t: T) {
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  const staff = await createUser(t, ADMIN);
  const ada = await createUser(t, "ada@example.invalid");
  const adaWs = await createWorkspace(t, ada, "ada", { kind: "personal" });
  const { code } = await asUser(t, ada).action(api.functions.textLinks.startPhoneLink, { phone: PHONE });
  await agentPost(t, "/agent-texts/link", { phone: PHONE, code });
  const opened = await agentPost(t, "/agent-texts/session", { phone: PHONE });
  return { staff, adaWs, accessToken: opened.accessToken as string };
}

async function send(t: T, body: Record<string, unknown>) {
  const response = await gatewayPost(t, "/gateway/tool-failures", { expectedWorkspaceId: null, ...body });
  return JSON.parse(await response.text()) as { kept: number };
}

const rows = (t: T) => t.run(async (ctx) => await ctx.db.query("texToolFailures").collect());

describe("tool failures", () => {
  test("a reason loses any value the gateway left, and is one short line", () => {
    expect(keptWhy("No note at <path>.")).toBe("No note at <path>.");
    expect(keptWhy("tried 3 times for @ada at https://example.com/x ada@example.invalid")).toBe("tried <n> times for <@> at <url> <email>");
    expect(keptWhy("line one\nline two")).toBe("line one line two");
    expect(keptWhy("x".repeat(500)).length).toBe(160);
    expect(keptWhy("")).toBe("(no reason given)");
  });

  test("a row names nobody, and keeps only a tool-shaped name and a known cause", async () => {
    const t = setupTest();
    const { adaWs, accessToken } = await world(t);
    const result = await send(t, {
      accessToken,
      kind: "one",
      failures: [
        { tool: "read_note", cause: "refused", why: "No note at <path>.", model: "anthropic/claude-haiku-5-5" },
        { tool: "read my brother's note", cause: "refused", why: "x" },
        { tool: "browse", cause: "made_up", why: "x" },
      ],
    });
    expect(result.kept).toBe(1);
    const [row] = await rows(t);
    expect(row).toMatchObject({ kind: "one", tool: "read_note", cause: "refused", why: "No note at <path>.", model: "anthropic/claude-haiku-5-5" });
    expect(row.at % 3_600_000).toBe(0);
    expect(JSON.stringify(row)).not.toContain(adaWs);
    expect(Object.keys(row).sort()).toEqual(["_creationTime", "_id", "at", "cause", "day", "kind", "model", "tool", "why"]);
  });

  test("nothing is kept without a live grant or with an unknown kind", async () => {
    const t = setupTest();
    const { accessToken } = await world(t);
    expect((await send(t, { accessToken: "not-a-token", kind: "one", failures: [{ tool: "read_note", cause: "refused", why: "no" }] })).kept).toBe(0);
    expect((await send(t, { accessToken, kind: "everything", failures: [{ tool: "read_note", cause: "refused", why: "no" }] })).kept).toBe(0);
    expect(await rows(t)).toHaveLength(0);
  });

  test("the report groups by tool, cause and reason, counts by day, and is staff only", async () => {
    const t = setupTest();
    const { staff } = await world(t);
    const now = Date.now();
    const hour = Math.floor(now / 3_600_000) * 3_600_000;
    const day = new Date(hour).toISOString().slice(0, 10);
    await t.run(async (ctx) => {
      for (const kind of ["one", "job", "one"]) await ctx.db.insert("texToolFailures", { at: hour, day, kind, tool: "browse", cause: "timed_out", why: "That call took too long and was stopped." });
      await ctx.db.insert("texToolFailures", { at: hour, day, kind: "check_in", tool: "browse", cause: "refused", why: "No page at <url>." });
    });
    const report = await asUser(t, staff).query(api.functions.admin.texReport, { days: 7 });
    expect(report.toolFailures.total).toBe(4);
    expect(report.toolFailures.byDay).toHaveLength(7);
    expect(report.toolFailures.byDay.at(-1)).toEqual({ day, failures: 4 });
    expect(report.toolFailures.reasons.map(({ tool, cause, count, kinds }) => ({ tool, cause, count, kinds }))).toEqual([
      { tool: "browse", cause: "timed_out", count: 3, kinds: ["job", "one"] },
      { tool: "browse", cause: "refused", count: 1, kinds: ["check_in"] },
    ]);
  });
});
