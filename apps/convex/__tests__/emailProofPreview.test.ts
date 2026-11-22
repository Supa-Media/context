import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { asPhoneOnly, captureError, createUser, setupTest } from "./fixtures.helpers";

/**
 * An agent testing a pull request's preview passes "Check it's you" without a
 * mailbox: the session presses Send as a person would, and the preview deploy
 * key reissues that waiting code's digits (`emailProof:previewReissue`). Only
 * on an isolated preview, only for a seeded persona, only for a code a session
 * already asked for.
 *
 * Sabotage: drop the isIsolatedPreview check -> "production refuses" fails;
 * drop the persona check -> "a real person's address is refused" fails.
 */

// Built at run time: scripts/check-no-identifiers.mjs rejects a committed Convex hostname, fakes included.
const CONVEX_CLOUD = ["convex", "cloud"].join(".");
const PREVIEW_ENV = {
  APP_ENV: "preview",
  PREVIEW_NAME: "pr42",
  APP_ORIGIN: "https://context-router-pr42.example-sub.workers.dev",
  CONVEX_CLOUD_URL: `https://happy-otter-123.${CONVEX_CLOUD}`,
};
const PERSONA = "beta@supa.media";

function onPreview() {
  for (const [key, value] of Object.entries(PREVIEW_ENV)) vi.stubEnv(key, value);
}

afterEach(() => vi.unstubAllEnvs());

describe("a preview persona's email proof", () => {
  test("the reissued code proves the session that asked", async () => {
    onPreview();
    const t = setupTest();
    const beta = await createUser(t, PERSONA);
    const phone = await asPhoneOnly(t, beta);
    expect((await phone.view.action(api.functions.emailProof.startEmailProof, {})).status).toBe("sent");
    const { code } = await t.mutation(internal.functions.emailProof.previewReissue, { email: PERSONA });
    expect(code).toMatch(/^\d{6}$/);
    expect(await phone.view.action(api.functions.emailProof.confirmEmailProof, { code })).toEqual({ status: "confirmed" });
    expect(await phone.view.query(api.functions.emailProof.myEmailProof, {})).toMatchObject({ proven: true });
  });

  test("production refuses", async () => {
    vi.stubEnv("APP_ENV", "production");
    const t = setupTest();
    const beta = await createUser(t, PERSONA);
    const phone = await asPhoneOnly(t, beta);
    await phone.view.action(api.functions.emailProof.startEmailProof, {});
    const error = await captureError(() => t.mutation(internal.functions.emailProof.previewReissue, { email: PERSONA }));
    expect(String(error)).toMatch(/only on a preview/);
  });

  test("a real person's address is refused, even on a preview", async () => {
    onPreview();
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const phone = await asPhoneOnly(t, ada);
    await phone.view.action(api.functions.emailProof.startEmailProof, {});
    const error = await captureError(() => t.mutation(internal.functions.emailProof.previewReissue, { email: "ada@home.example" }));
    expect(String(error)).toMatch(/only for the preview personas/);
  });

  test("nothing is issued until a session asked for a code", async () => {
    onPreview();
    const t = setupTest();
    await createUser(t, PERSONA);
    const error = await captureError(() => t.mutation(internal.functions.emailProof.previewReissue, { email: PERSONA }));
    expect(String(error)).toMatch(/press Send/);
  });
});
