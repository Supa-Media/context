/**
 * `/gateway/links/create` — AN OWNER WHO IS REFUSED A LINK IS TOLD WHY.
 *
 * The incident (2026-09-24): an owner asked their assistant for an intake form
 * and a link to it. The note was private, the mint threw
 * `PATH_NOT_TEAM_VISIBLE`, and the throw escaped the HTTP action as a bare 500
 * — which the gateway can only report as "control plane unavailable". Four
 * retries, four 500s, and nothing on either side said the note just needed
 * publishing to the workspace first.
 *
 * What is proved here:
 *
 *  1. A refusal that happens AFTER the owner clearance is an answer, not an
 *     outage: HTTP 200, `link: null`, and the owner-facing sentence the console
 *     shows for the same refusal.
 *  2. A caller who is not cleared still gets the one bare `null`, with no
 *     reason — the clearance is what decides whether a reason is safe to give.
 *  3. The ordinary path still mints.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { renderPrivacyManifest } from "../../functions/lib/scaffold";
import { memoryS3 } from "../storeStub.helpers";
import {
  FAKE_STORAGE,
  asUser,
  bindFakeStorage,
  createUser,
  createWorkspace,
  gatewayPost,
  setupTest,
} from "../fixtures.helpers";
import { api } from "../../_generated/api";
import { bodyOf, registerClient, seedConnectedClient, token } from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const OWNER_ACCESS = token("links_owner");
const EDITOR_ACCESS = token("links_editor");
const TEAM_NOTE = "1-projects/intake.md";
const PRIVATE_NOTE = "2-areas/clients/new-client.md";

async function fixture() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const editor = await createUser(t, "editor@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  await t.run((ctx) =>
    ctx.db.insert("workspaceMembers", {
      workspaceId,
      userId: editor,
      role: "editor" as const,
      joinedAt: Date.now(),
    }),
  );

  const backend = memoryS3(FAKE_STORAGE.bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  backend.seed(TEAM_NOTE, "# Intake\n");
  backend.seed(PRIVATE_NOTE, "# New client\n");
  vi.stubGlobal("fetch", backend.fetchImpl);
  await bindFakeStorage(t, owner, workspaceId);
  await asUser(t, owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId,
    path: "1-projects",
    visibility: "team",
  });

  await registerClient(t, "mcp_client_links");
  await seedConnectedClient(t, {
    workspaceId,
    userId: owner,
    clientId: "mcp_client_links",
    accessToken: OWNER_ACCESS,
    scopes: ["context:read", "context:write", "context:private"],
  });
  await seedConnectedClient(t, {
    workspaceId,
    userId: editor,
    clientId: "mcp_client_links",
    accessToken: EDITOR_ACCESS,
    scopes: ["context:read", "context:write"],
  });
  return { t, workspaceId };
}

describe("/gateway/links/create", () => {
  test("an owner refused a link over a private note gets the reason, not a 500", async () => {
    const { t, workspaceId } = await fixture();
    const response = await gatewayPost(t, "/gateway/links/create", {
      accessToken: OWNER_ACCESS,
      expectedWorkspaceId: workspaceId,
      path: PRIVATE_NOTE,
      audience: "anyone",
      kind: "note",
      mode: "collect",
      short: "new-client",
    });
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.link).toBeNull();
    expect(body.refused).toMatch(/team cannot read that note/i);
    const rows = await t.run((ctx) => ctx.db.query("noteShares").collect());
    expect(rows).toHaveLength(0);
  });

  test("a caller who is not cleared gets the bare null, with no reason", async () => {
    const { t, workspaceId } = await fixture();
    const response = await gatewayPost(t, "/gateway/links/create", {
      accessToken: EDITOR_ACCESS,
      expectedWorkspaceId: workspaceId,
      path: PRIVATE_NOTE,
      audience: "anyone",
      kind: "note",
    });
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.link).toBeNull();
    expect(body.refused ?? null).toBeNull();
  });

  test("a team-visible note still mints a collect link with its short name", async () => {
    const { t, workspaceId } = await fixture();
    const body = await bodyOf(
      await gatewayPost(t, "/gateway/links/create", {
        accessToken: OWNER_ACCESS,
        expectedWorkspaceId: workspaceId,
        path: TEAM_NOTE,
        audience: "anyone",
        kind: "note",
        mode: "collect",
        short: "new-client",
      }),
    );
    const link = body.link as { collecting: boolean; slug: string | null };
    expect(link).not.toBeNull();
    expect(link.collecting).toBe(true);
    expect(link.slug).toBe("new-client");
    expect(body.shortRefused).toBeNull();
  });
});
