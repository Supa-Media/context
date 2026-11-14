import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { ADMIN, tester, user } from "./noteIds/noteIds.helpers";
import { withSession } from "./session.helpers";

/**
 * TEX'S OLD NUMBER (`functions/texOldLine.ts`): the one setting that says whether the old Sendblue line answers with the
 * new number. Staff only, audited, and read by the Worker through `/agent-texts/old-line` behind its own secret.
 *
 * Sabotage (temporary local edits, reverted): dropping `requireAdmin` from `setTexOldLine` fails "a stranger can neither
 * read nor set it"; accepting `redirect` without a number fails "refuses a number"; dropping the audit call fails the
 * audit test; answering the Worker route without its secret fails "refuses without the agent worker's own secret".
 */

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const NUMBER = "+18133350746";

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
});
afterEach(() => {
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

async function worker(t: ReturnType<typeof tester>, secret: string | null = AGENT_SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  const response = await t.fetch("/agent-texts/old-line", { method: "POST", headers, body: "{}" });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
}

describe("Tex's old number, as staff see it", () => {
  test("is off until staff set it", async () => {
    const t = tester();
    const staff = withSession(t, await user(t, ADMIN));
    expect(await staff.query(api.functions.texOldLine.getTexOldLine, {})).toEqual({
      mode: "off",
      number: null,
      archiveOn: null,
      updatedAt: null,
      updatedBy: null,
    });
  });

  test("a stranger can neither read nor set it", async () => {
    const t = tester();
    const ada = withSession(t, await user(t, "ada@example.test"));
    await expect(ada.query(api.functions.texOldLine.getTexOldLine, {})).rejects.toThrow();
    await expect(
      ada.mutation(api.functions.texOldLine.setTexOldLine, { mode: "redirect", number: NUMBER, archiveOn: null }),
    ).rejects.toThrow();
  });

  test("redirect with a number and an archive day is kept and read back, with the acting staff member", async () => {
    const t = tester();
    const staffId = await user(t, ADMIN);
    const staff = withSession(t, staffId);
    const saved = await staff.mutation(api.functions.texOldLine.setTexOldLine, {
      mode: "redirect",
      number: NUMBER,
      archiveOn: "2026-12-01",
    });
    expect(saved).toMatchObject({ mode: "redirect", number: NUMBER, archiveOn: "2026-12-01", updatedBy: staffId });
    expect(await staff.query(api.functions.texOldLine.getTexOldLine, {})).toMatchObject({ mode: "redirect", number: NUMBER });
  });

  test("the change is audited with the acting identity", async () => {
    const t = tester();
    const staffId = await user(t, ADMIN);
    await withSession(t, staffId).mutation(api.functions.texOldLine.setTexOldLine, { mode: "redirect", number: NUMBER, archiveOn: null });
    const events = await t.run((ctx) => ctx.db.query("adminAuditEvents").collect());
    const event = events.find((row) => row.action === "tex.old_line_set");
    expect(event).toMatchObject({ actorUserId: staffId, actorEmail: ADMIN, subject: "tex.old_line", details: { mode: "redirect" } });
  });

  test("refuses a number that is not E.164, a redirect with no number, and an archive day that is not a real day", async () => {
    const t = tester();
    const staff = withSession(t, await user(t, ADMIN));
    const set = (args: { mode: "off" | "redirect"; number: string | null; archiveOn: string | null }) =>
      staff.mutation(api.functions.texOldLine.setTexOldLine, args);
    await expect(set({ mode: "redirect", number: "8133350746", archiveOn: null })).rejects.toThrow(/E\.164/);
    await expect(set({ mode: "redirect", number: null, archiveOn: null })).rejects.toThrow(/needs a number/);
    await expect(set({ mode: "redirect", number: NUMBER, archiveOn: "2026-02-30" })).rejects.toThrow(/day/);
    await expect(set({ mode: "redirect", number: NUMBER, archiveOn: "Dec 1" })).rejects.toThrow(/day/);
    expect(await staff.query(api.functions.texOldLine.getTexOldLine, {})).toMatchObject({ mode: "off" });
  });

  test("switching back off keeps the number for next time", async () => {
    const t = tester();
    const staff = withSession(t, await user(t, ADMIN));
    await staff.mutation(api.functions.texOldLine.setTexOldLine, { mode: "redirect", number: NUMBER, archiveOn: "2026-12-01" });
    const off = await staff.mutation(api.functions.texOldLine.setTexOldLine, { mode: "off", number: NUMBER, archiveOn: null });
    expect(off).toMatchObject({ mode: "off", number: NUMBER, archiveOn: null });
  });
});

describe("Tex's old number, as the Worker reads it", () => {
  test("refuses without the agent worker's own secret", async () => {
    const t = tester();
    for (const secret of [null, "wrong", "test-gateway-secret-not-the-agent"]) {
      expect((await worker(t, secret)).status).toBe(401);
    }
  });

  test("answers the setting to the Worker, and the default when none is set", async () => {
    const t = tester();
    expect(await worker(t)).toEqual({ status: 200, body: { mode: "off", number: null, archiveOn: null } });
    const staff = withSession(t, await user(t, ADMIN));
    await staff.mutation(api.functions.texOldLine.setTexOldLine, { mode: "redirect", number: NUMBER, archiveOn: "2026-12-01" });
    expect(await worker(t)).toEqual({ status: 200, body: { mode: "redirect", number: NUMBER, archiveOn: "2026-12-01" } });
  });
});
