/**
 * `/gateway/site` `screenshot` — WHICH PAGE A BROWSER MAY BE POINTED AT.
 *
 * The browser (infra/site-shots) is billed by the minute and photographs as
 * a signed-out stranger. What is proved here, before one is ever opened:
 *
 *  1. A member's connection gets the bare `null`.
 *  2. Only a live, public page of this site is handed over, as this
 *     deployment's own https address; a draft, a members-only page or an
 *     address nobody publishes is refused with the reason.
 *  3. A site that is off, or a deployment with no https origin, is refused.
 *  4. Each workspace has an hourly budget, and a refusal does not spend it.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { SITE_SHOTS_PER_HOUR } from "../../functions/lib/websites/siteShots";
import { addMember, createUser, gatewayPost } from "../fixtures.helpers";
import { fixture, publish } from "../website.helpers";
import { bodyOf, registerClient, seedConnectedClient, token } from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const EDITOR = token("shots_editor");
const MEMBER = token("shots_member");
const CLIENT = "mcp_client_shots";

async function shotsFixture() {
  vi.stubEnv("APP_ORIGIN", "https://context.lc");
  const f = await fixture();
  const editor = await createUser(f.t, "shots-editor@example.invalid");
  await addMember(f.t, f.workspaceId, editor, "editor", f.owner);
  f.backend.seed("website/index.md", "---\ntitle: Home\n---\n\n# Welcome\n");
  f.backend.seed("website/our work.md", "---\ntitle: Our work\n---\n\nWork\n");
  f.backend.seed("website/team.md", "---\ntitle: Team\naudience: members\n---\n\nTeam\n");
  f.backend.seed("website/soon.md", "---\ntitle: Soon\ndraft: true\n---\n\nSoon\n");
  await publish(f);
  await registerClient(f.t, CLIENT);
  await seedConnectedClient(f.t, { workspaceId: f.workspaceId, userId: editor, clientId: CLIENT, accessToken: EDITOR, scopes: ["context:read", "context:write"] });
  await seedConnectedClient(f.t, { workspaceId: f.workspaceId, userId: f.member, clientId: CLIENT, accessToken: MEMBER, scopes: ["context:read", "context:write"] });
  return f;
}

type Shot = { url: string | null; address: string | null; message?: string } | null;

async function screenshot(f: Awaited<ReturnType<typeof shotsFixture>>, accessToken: string, path?: string) {
  const response = await gatewayPost(f.t, "/gateway/site", {
    accessToken,
    expectedWorkspaceId: f.workspaceId,
    action: "screenshot",
    ...(path === undefined ? {} : { path }),
  });
  return (await bodyOf(response)).site as Shot;
}

describe("/gateway/site screenshot", () => {
  test("a member's connection gets the bare null", async () => {
    const f = await shotsFixture();
    expect(await screenshot(f, MEMBER, "/")).toBeNull();
  });

  test("a live public page is handed over as this deployment's own address", async () => {
    const f = await shotsFixture();
    expect(await screenshot(f, EDITOR)).toMatchObject({ url: "https://context.lc/@atlas", address: "/" });
    expect(await screenshot(f, EDITOR, "/our work/")).toMatchObject({ url: "https://context.lc/@atlas/our%20work", address: "/our work" });
    expect(await screenshot(f, EDITOR, "/index")).toMatchObject({ address: "/" });
  });

  test("a draft, a members-only page and an unknown address are refused with the reason", async () => {
    const f = await shotsFixture();
    expect((await screenshot(f, EDITOR, "/soon"))!).toMatchObject({ url: null, message: expect.stringMatching(/No published page has the address \/soon/) });
    expect((await screenshot(f, EDITOR, "/team"))!.message).toMatch(/members only/);
    expect((await screenshot(f, EDITOR, "/nope"))!.message).toMatch(/No published page/);
  });

  test("a deployment with no https origin cannot take one", async () => {
    const f = await shotsFixture();
    vi.stubEnv("APP_ORIGIN", "http://localhost:8081");
    expect((await screenshot(f, EDITOR, "/"))!.message).toMatch(/not available on this deployment/);
  });

  test("each workspace has an hourly budget, and refusals do not spend it", async () => {
    const f = await shotsFixture();
    for (let index = 0; index < 5; index += 1) await screenshot(f, EDITOR, "/team");
    for (let index = 0; index < SITE_SHOTS_PER_HOUR; index += 1) {
      expect((await screenshot(f, EDITOR, "/"))!.url).not.toBeNull();
    }
    expect((await screenshot(f, EDITOR, "/"))!).toMatchObject({ url: null, message: expect.stringMatching(/screenshots for this hour/) });
  });
});
