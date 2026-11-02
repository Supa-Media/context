/**
 * TEX READS ITS SETUP IN THE PIN, WHOEVER THE PERSON IS, AND NOTHING ELSE THERE
 * (`functions/lib/texSetupRead.ts`; owner, 2026-11-02: "peoples tex should always have access to the production note").
 *
 * A person who reaches `@context-lc` through the pin alone reads it as a guest, where the staff-only `team` setup is
 * hidden, so Tex ran on its built-in words for them, and for every group chat. `/gateway/binding` with `setupRead`
 * now answers a Tex client's token for the pin with a member's rules narrowed to `ai/production` and `ai/agents`.
 *
 * Claims: the setup is visible through it; nothing else in the pin is, a team note beside it included; an AI client's
 * token and any workspace but the pin get no binding at all; and the person's own reading is unchanged.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `openStorageBinding` skipping the client check. → "an AI client's token gets no setup read" fails.
 *  2. `openStorageBinding` skipping the pin check. → "no workspace but the pin" fails.
 *  3. `setupRules` keeping every member rule. → "sees the setup and nothing else" fails (a team note outside shows).
 *
 * Every value here is fake. This repository is public.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { asUser, gatewayPost, seedStorageBinding } from "./fixtures.helpers";
import { registerClient, seedConnectedClient, token } from "./controlPlane/fixtures.helpers";
import { GUIDE, PLAN, migrate, pinnedWorld, setRow, type PinnedWorld } from "./pinnedReaders.helpers";
import { canSee, PrivacyOverrides, type PrivacyRule, type Visibility } from "../functions/lib/privacy";
import { setupRules } from "../functions/lib/texSetupRead";

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const SETUP = "ai/production/texting-assistant.md";
const SKILL = "ai/production/skills/onboarding.md";
const HELPER = "ai/agents/codex.md";
const BESIDE = "ai/results/scores.md";
const TEX_TOKEN = token("setup_tex");
const GROUP_TOKEN = token("setup_grp");
const APP_TOKEN = token("setup_app");

type Held = { folders: Array<{ prefix: string; visibility: string }>; notes: Array<{ path: string; visibility: string }> };

/** Whether a read at `team` with no names sees `path` under the rules the binding carried, as the gateway judges. */
function seenBy(held: Held, path: string): boolean {
  const rules: PrivacyRule[] = held.folders.map((rule) => ({ prefix: rule.prefix, vis: rule.visibility as Visibility }));
  const overrides = new PrivacyOverrides();
  for (const note of held.notes) overrides.set(note.path, note.visibility as Visibility);
  return canSee(path, "team", rules, overrides, new Set());
}

async function world(): Promise<PinnedWorld & { sayoOwn: string }> {
  const w = await pinnedWorld();
  const staff = asUser(w.t, w.staff);
  for (const path of [SETUP, SKILL, HELPER, BESIDE]) {
    await staff.action(api.functions.files.writeNote, { workspaceId: w.pinned, path, text: `# ${path}\n` });
  }
  // The staff folder is members-only `team`, as `ai/` is in production.
  await setRow(w, "ai", "team");
  await migrate(w);
  const sayoOwn = (await w.t.run(async (ctx) => (await ctx.db.query("workspaces").withIndex("by_slug", (q) => q.eq("slug", "sayo")).unique())!._id)) as string;
  const sayoOwnId = sayoOwn as never;
  await seedStorageBinding(w.t, { workspaceId: sayoOwnId, boundBy: w.sayo, bucket: "sayo-own-bucket" });
  for (const clientId of ["context_texts", "context_heartbeat", "mcp_client_setup_app"]) await registerClient(w.t, clientId);
  await seedConnectedClient(w.t, { workspaceId: sayoOwnId, userId: w.sayo, clientId: "context_texts", accessToken: TEX_TOKEN, scopes: ["context:read", "context:write"] });
  await seedConnectedClient(w.t, { workspaceId: sayoOwnId, userId: w.sayo, clientId: "context_heartbeat", accessToken: GROUP_TOKEN, scopes: ["context:read"] });
  await seedConnectedClient(w.t, { workspaceId: sayoOwnId, userId: w.sayo, clientId: "mcp_client_setup_app", accessToken: APP_TOKEN, scopes: ["context:read", "context:write"] });
  return { ...w, sayoOwn };
}

async function binding(w: PinnedWorld, accessToken: string, workspaceId: string, setupRead: boolean) {
  return (await (
    await gatewayPost(w.t, "/gateway/binding", { accessToken, expectedWorkspaceId: workspaceId, ...(setupRead ? { setupRead: true } : {}) })
  ).json()) as { binding: { workspaceId: string } | null; privacy?: Held };
}

describe("Tex's setup read of the pin", () => {
  test("sees the setup, its skills and the helper agents, and nothing else, for a person who is not a member", async () => {
    const w = await world();
    for (const accessToken of [TEX_TOKEN, GROUP_TOKEN]) {
      const opened = await binding(w, accessToken, w.pinned, true);
      expect(opened.binding?.workspaceId).toBe(w.pinned);
      for (const path of [SETUP, SKILL, HELPER]) expect(seenBy(opened.privacy!, path), path).toBe(true);
      for (const path of [BESIDE, GUIDE, PLAN, "index.md"]) expect(seenBy(opened.privacy!, path), path).toBe(false);
    }
  });

  test("the person's own reading of the pin is unchanged: the setup stays hidden from them", async () => {
    const w = await world();
    const opened = await binding(w, TEX_TOKEN, w.pinned, false);
    expect(opened.binding?.workspaceId).toBe(w.pinned);
    expect(seenBy(opened.privacy!, SETUP)).toBe(false);
  });

  test("an AI client's token gets no setup read", async () => {
    const w = await world();
    expect((await binding(w, APP_TOKEN, w.pinned, true)).binding).toBeNull();
  });

  test("no workspace but the pin is opened by a setup read", async () => {
    const w = await world();
    expect((await binding(w, TEX_TOKEN, w.sayoOwn, true)).binding).toBeNull();
    // And the same token's ordinary read of its own workspace still works.
    expect((await binding(w, TEX_TOKEN, w.sayoOwn, false)).binding?.workspaceId).toBe(w.sayoOwn);
  });
});

describe("setupRules", () => {
  test("keeps each setup folder at the visibility a member reads it, its rules beneath, and drops the rest", () => {
    const member = {
      rules: [
        { prefix: "ai", vis: "team" as Visibility },
        { prefix: "ai/production/private", vis: "private" as Visibility },
        { prefix: "guides", vis: "team" as Visibility },
      ],
      overrides: new Map<string, Visibility>([
        ["ai/production/held.md", "private"],
        ["guides/start.md", "team"],
      ]),
    };
    const narrowed = setupRules(member);
    expect(narrowed.rules).toEqual([
      { prefix: "ai/production", vis: "team" },
      { prefix: "ai/production/private", vis: "private" },
      { prefix: "ai/agents", vis: "team" },
    ]);
    expect([...narrowed.overrides]).toEqual([["ai/production/held.md", "private"]]);
  });
});
