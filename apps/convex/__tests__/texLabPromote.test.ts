/**
 * Promoting a Lab version (`functions/texLabPromote.ts`; Dev2, 2026-11-13: the Lab's config is "the only source of
 * truth"): staff ask, the workflow reads the asks and answers with its pull request or why it refused, and nobody
 * else can ask. Promote changes nothing Tex runs: only the pull request it opens can.
 *
 * Sabotage (temporary local edits, reverted): removing `requireAdmin` from `ask` fails "a stranger cannot ask";
 * dropping the `at` comparison in `answered` fails "an answer for an older ask leaves the newer one waiting".
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { ADMIN, tester, user } from "./noteIds/noteIds.helpers";
import { withSession } from "./session.helpers";

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
});
afterEach(() => {
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

const version = { versionId: "vabc123", name: "Reviewer at medium", graph: '{"nodes":[],"edges":[]}', picks: "{}", results: "[]", createdAt: 1 };
const PR = "https://github.com/Supa-Media/context/pull/9999";

describe("promoting a Lab version", () => {
  test("staff ask, the workflow sees the ask, and its pull request is kept on the version", async () => {
    const t = tester();
    const staff = withSession(t, await user(t, ADMIN));
    await staff.mutation(api.functions.texLab.saveVersion, version);
    await staff.mutation(api.functions.texLabPromote.ask, { versionId: "vabc123" });
    const asks = await t.query(internal.functions.texLabPromote.asked, {});
    expect(asks.map((a) => [a.versionId, a.name, a.graph])).toEqual([["vabc123", "Reviewer at medium", version.graph]]);
    expect((await staff.query(api.functions.texLab.list, {})).versions[0].promote).toEqual({ state: "asked", pr: null, why: null });

    await t.mutation(internal.functions.texLabPromote.answered, { versionId: "vabc123", at: asks[0].at, pr: PR });
    expect(await t.query(internal.functions.texLabPromote.asked, {})).toEqual([]);
    expect((await staff.query(api.functions.texLab.list, {})).versions[0].promote).toEqual({ state: "opened", pr: PR, why: null });
  });

  test("a refusal says why, and an answer for an older ask leaves the newer one waiting", async () => {
    const t = tester();
    const staff = withSession(t, await user(t, ADMIN));
    await staff.mutation(api.functions.texLab.saveVersion, version);
    await staff.mutation(api.functions.texLabPromote.ask, { versionId: "vabc123" });
    const [ask] = await t.query(internal.functions.texLabPromote.asked, {});
    await t.mutation(internal.functions.texLabPromote.answered, { versionId: "vabc123", at: ask.at - 1, why: "stale" });
    expect(await t.query(internal.functions.texLabPromote.asked, {})).toHaveLength(1);
    await t.mutation(internal.functions.texLabPromote.answered, { versionId: "vabc123", at: ask.at, why: 'step "brandnew" is new' });
    expect((await staff.query(api.functions.texLab.list, {})).versions[0].promote).toEqual({ state: "refused", pr: null, why: 'step "brandnew" is new' });
  });

  test("a stranger cannot ask, main and an unsaved version cannot be promoted, and only a pull request address is kept", async () => {
    const t = tester();
    const staff = withSession(t, await user(t, ADMIN));
    await staff.mutation(api.functions.texLab.saveVersion, version);
    const stranger = withSession(t, await user(t, "someone@example.test"));
    await expect(stranger.mutation(api.functions.texLabPromote.ask, { versionId: "vabc123" })).rejects.toThrow();
    await expect(staff.mutation(api.functions.texLabPromote.ask, { versionId: "main" })).rejects.toThrow(/already/);
    await expect(staff.mutation(api.functions.texLabPromote.ask, { versionId: "vnope" })).rejects.toThrow(/Save/);
    await staff.mutation(api.functions.texLabPromote.ask, { versionId: "vabc123" });
    const [ask] = await t.query(internal.functions.texLabPromote.asked, {});
    await expect(t.mutation(internal.functions.texLabPromote.answered, { versionId: "vabc123", at: ask.at, pr: "https://evil.example/x" })).rejects.toThrow(/pull request/);
  });
});
