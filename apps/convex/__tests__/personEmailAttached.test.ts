/**
 * An email with files the person's AI attached is read back from Gmail after
 * it is saved or sent, and the answer says what Gmail holds
 * (`functions/lib/personEmailCheck.ts`). A review of a chat, 2026-10-27: Tex
 * said a draft had "the screenshot attached" when Gmail held the wrong one,
 * then an empty file.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-27).
 * `attachedParts` reading only the top-level part failed "every file Gmail
 * holds is named, however deep its part"; answering without `attached`
 * failed "a draft with a picture says what Gmail holds".
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { gatewayPost, seedGoogleConnection } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { ACCESS_A, bodyOf, twoConnectedTenants } from "./controlPlane/fixtures.helpers";
import { GMAIL_COMPOSE_SCOPE, GMAIL_SEND_SCOPE } from "../functions/lib/personEmail";
import { attachedParts } from "../functions/lib/personEmailCheck";

const realFetch = globalThis.fetch;
const READ = "https://www.googleapis.com/auth/gmail.readonly";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Gmail, answered here: the upload is taken, and a read of the draft answers `held`. */
function gmail(held: unknown, read = 200) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://gmail.googleapis.com/")) return await realFetch(input, init);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ id: "draft_fake", message: { id: "m1", payload: held } }), { status: read });
    return new Response(JSON.stringify({ id: "draft_fake", message: { id: "m1" } }), { status: 200 });
  });
  return calls;
}

async function connected() {
  const tenants = await twoConnectedTenants();
  const id = await seedGoogleConnection(tenants.t, { workspaceId: tenants.aliceWs, boundBy: tenants.alice, address: "alice@gmail.example" });
  const encryptedAccessToken = await encryptSecret("ya29.fake-access-token", requireKeyset(), { workspaceId: tenants.aliceWs });
  await tenants.t.run((ctx) => ctx.db.patch(id, { scopes: [READ, GMAIL_SEND_SCOPE, GMAIL_COMPOSE_SCOPE], encryptedAccessToken, accessTokenExpiresAt: Date.now() + 60 * 60 * 1000 }));
  return tenants;
}

const EMAIL = {
  to: ["help@example.invalid"],
  subject: "Link previews",
  body: "Hi,\n\nThe example is attached.",
  files: [{ filename: "IMG_2691.png", contentType: "image/png", data: btoa("PNGBYTES") }],
};

const payload = (size: number) => ({
  mimeType: "multipart/mixed",
  filename: "",
  parts: [
    { mimeType: "multipart/alternative", filename: "", parts: [{ mimeType: "text/plain", filename: "", body: { size: 30 } }] },
    { mimeType: "image/png", filename: "IMG_2691.png", body: { size, attachmentId: "a1" } },
  ],
});

describe("an email's files, read back from Gmail", () => {
  test("every file Gmail holds is named, however deep its part", () => {
    expect(attachedParts(payload(8))).toEqual([{ filename: "IMG_2691.png", size: 8 }]);
    expect(attachedParts({ parts: [{ parts: [{ filename: "deep.pdf", body: { size: 3 } }] }] })).toEqual([{ filename: "deep.pdf", size: 3 }]);
    expect(attachedParts({ filename: "", body: { size: 10 } })).toEqual([]);
    expect(attachedParts(null)).toEqual([]);
  });

  test("a draft with a picture says what Gmail holds", async () => {
    const calls = gmail(payload(8));
    const { t, aliceWs } = await connected();
    const answer = await bodyOf(await gatewayPost(t, "/gateway/email/draft", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, email: EMAIL }));
    expect(answer).toEqual({ ok: true, from: "alice@gmail.example", attached: [{ filename: "IMG_2691.png", size: 8 }] });
    expect(calls).toEqual([
      "POST https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media",
      "GET https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft_fake?format=full",
    ]);
  });

  test("an empty file is reported as Gmail holds it, so the AI never calls it attached", async () => {
    gmail(payload(0));
    const { t, aliceWs } = await connected();
    const answer = await bodyOf(await gatewayPost(t, "/gateway/email/draft", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, email: EMAIL }));
    expect(answer).toEqual({ ok: true, from: "alice@gmail.example", attached: [{ filename: "IMG_2691.png", size: 0 }] });
  });

  test("a read-back that fails still answers saved, with nothing claimed", async () => {
    gmail(payload(8), 500);
    const { t, aliceWs } = await connected();
    const answer = await bodyOf(await gatewayPost(t, "/gateway/email/draft", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, email: EMAIL }));
    expect(answer).toEqual({ ok: true, from: "alice@gmail.example" });
  });
});
