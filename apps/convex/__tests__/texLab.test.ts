/**
 * The Tex Architecture Lab's saving (`functions/texLab.ts`): staff share versions and case edits, nobody else can
 * read or write either, and the shapes it keeps are checked.
 *
 * Sabotage (temporary local edits, reverted): removing `requireAdmin` from `list` fails "a stranger reads nothing";
 * from `saveCase` fails "a stranger writes nothing"; dropping the `VERSION_ID` test fails "a made-up id is refused".
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
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

const version = { versionId: "vabc123", name: "Haiku judge", graph: '{"nodes":[],"edges":[]}', picks: "{}", results: "[]", createdAt: 1 };

describe("the Lab's shared versions", () => {
  test("staff save, read back, rename and delete a version, and keep a case edit", async () => {
    const t = tester();
    const staffId = await user(t, ADMIN);
    const staff = withSession(t, staffId);
    await staff.mutation(api.functions.texLab.saveVersion, version);
    await staff.mutation(api.functions.texLab.saveVersion, { ...version, name: "Haiku judge, faster" });
    await staff.mutation(api.functions.texLab.saveCase, { key: "core/q1", data: '{"area":"core","id":"q1","ask":"x","expect":"y"}' });
    const got = await staff.query(api.functions.texLab.list, {});
    expect(got.me).toBe(staffId);
    expect(got.versions.map((v) => [v.versionId, v.name, v.authorId])).toEqual([["vabc123", "Haiku judge, faster", staffId]]);
    expect(got.caseEdits.map((c) => c.key)).toEqual(["core/q1"]);
    expect(got.names).toEqual({ [staffId]: "Someone" });

    await staff.mutation(api.functions.texLab.saveCase, { key: "core/q1", data: null });
    await staff.mutation(api.functions.texLab.deleteVersion, { versionId: "vabc123" });
    const after = await staff.query(api.functions.texLab.list, {});
    expect([after.versions.length, after.caseEdits.length]).toEqual([0, 0]);
  });

  test("a stranger reads nothing and writes nothing", async () => {
    const t = tester();
    const staff = withSession(t, await user(t, ADMIN));
    await staff.mutation(api.functions.texLab.saveVersion, version);
    const stranger = withSession(t, await user(t, "someone@example.test"));
    await expect(stranger.query(api.functions.texLab.list, {})).rejects.toThrow();
    await expect(stranger.mutation(api.functions.texLab.saveVersion, { ...version, versionId: "vzzz" })).rejects.toThrow();
    await expect(stranger.mutation(api.functions.texLab.saveCase, { key: "core/q1", data: "{}" })).rejects.toThrow();
    await expect(stranger.mutation(api.functions.texLab.deleteVersion, { versionId: "vabc123" })).rejects.toThrow();
    expect((await staff.query(api.functions.texLab.list, {})).versions).toHaveLength(1);
  });

  test("a made-up id, a bad case key and an oversized graph are refused", async () => {
    const t = tester();
    const staff = withSession(t, await user(t, ADMIN));
    await expect(staff.mutation(api.functions.texLab.saveVersion, { ...version, versionId: "../x" })).rejects.toThrow(/version id/);
    await expect(staff.mutation(api.functions.texLab.saveCase, { key: "nope", data: "{}" })).rejects.toThrow(/case key/);
    await expect(staff.mutation(api.functions.texLab.saveVersion, { ...version, graph: "x".repeat(400_001) })).rejects.toThrow(/too big/);
  });
});
