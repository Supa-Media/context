const { afterEach, beforeEach, describe, expect, test } = require("@jest/globals");

/**
 * The EAS project id used to be a literal committed to `app.config.js` —
 * `apps/mobile/eas.json`'s Apple team id sat beside it the same way. Both are
 * account identifiers with no business in a public, MIT-licensed repository
 * (see CLAUDE.md, "This repository is public and MIT licensed"), so the id
 * now comes from `process.env.EAS_PROJECT_ID`, set from the `EAS_PROJECT_ID`
 * secret (`scripts/secrets-allowlist.json`) in CI and from `.env.local`
 * locally.
 *
 * ## Why this has to keep working with nothing set
 *
 * `runtimeVersion.test.js` already `require`s this file with no environment
 * configured, and so does `expo export --platform web` when it runs outside
 * EAS (CI's `deploy-web.yml` job, or a developer's laptop). Both are ordinary,
 * working states — not the placeholder the CI check in `deploy-web.yml`
 * already knows how to catch (`""` or `YOUR_EAS_PROJECT_ID`), which is why the
 * fallback below is exactly that literal rather than a new one.
 *
 * ## Why an actual EAS build gets no fallback
 *
 * `EAS_BUILD` is the environment variable EAS Build sets to `"true"` on its
 * own remote worker — the one place a placeholder project id would silently
 * link the build to nothing, or to the wrong project, rather than failing.
 * That is worse than refusing outright, so the placeholder only survives
 * everywhere EAS_BUILD is not `"true"`.
 */
describe("app.config.js reads EAS_PROJECT_ID from the environment", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.EAS_PROJECT_ID;
    delete process.env.EAS_BUILD;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test("with nothing set, config still loads — for tests and local dev", () => {
    const config = require("../app.config.js")({ config: {} });
    expect(config.extra.eas.projectId).toBe("YOUR_EAS_PROJECT_ID");
    expect(config.updates.url).toBe("https://u.expo.dev/YOUR_EAS_PROJECT_ID");
  });

  test("with EAS_PROJECT_ID set, it is used verbatim", () => {
    process.env.EAS_PROJECT_ID = "11111111-2222-3333-4444-555555555555";
    const config = require("../app.config.js")({ config: {} });
    expect(config.extra.eas.projectId).toBe("11111111-2222-3333-4444-555555555555");
    expect(config.updates.url).toBe(
      "https://u.expo.dev/11111111-2222-3333-4444-555555555555",
    );
  });

  test("on an EAS build with no EAS_PROJECT_ID, it fails clearly instead of shipping a placeholder", () => {
    process.env.EAS_BUILD = "true";
    expect(() => require("../app.config.js")({ config: {} })).toThrow(/EAS_PROJECT_ID/);
  });

  test("on an EAS build with EAS_PROJECT_ID set, it does not throw", () => {
    process.env.EAS_BUILD = "true";
    process.env.EAS_PROJECT_ID = "11111111-2222-3333-4444-555555555555";
    expect(() => require("../app.config.js")({ config: {} })).not.toThrow();
  });
});
