/**
 * `build/release-local.sh`: a signed release from a Mac when GitHub has no Mac
 * runner. Checked here by its text, since nothing but a Mac can run it.
 *
 * Sabotage record (each change made by hand, the named check went red):
 *   - passing CSC_LINK to electron-builder                       "signs from its own keychain"
 *   - installing after the notarize.cjs --check (2026-11-04, the first real run) "installs dependencies before"
 *   - dropping the origin/main comparison                        "only from origin/main"
 *   - removing the workflow's older-than-latest refusal          "the workflow refuses an older version"
 *   - CONTEXT_DESKTOP_SIGNED only on electron-builder (v0.1.71-72) "bakes the signed flag into the build"
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./fixtures.mjs";

export async function runReleaseLocalChecks(check) {
  const script = readFileSync(join(ROOT, "build/release-local.sh"), "utf8");
  const code = script.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  const at = (text) => code.indexOf(text);

  check(
    "release-local: publishes only after the build verifies and the app opens with --smoke",
    at("gh release create") > at("--smoke") && at("--smoke") > at("spctl --assess") && at("spctl --assess") > at("electron-builder --mac"),
  );
  check(
    "release-local: bakes the signed flag into the build, and refuses a bundle without it (v0.1.71-72 could not update)",
    /CONTEXT_DESKTOP_SIGNED=true pnpm run build/.test(code) && at('grep -q "signed: true" dist/main/index.cjs') > at("CONTEXT_DESKTOP_SIGNED=true pnpm run build") &&
      at('grep -q "signed: true" dist/main/index.cjs') < at("electron-builder --mac"),
  );
  check(
    "release-local: installs dependencies before the notarisation key check, which needs @electron/notarize",
    at("pnpm install") > 0 && at("pnpm install") < at("notarize.cjs --check"),
  );
  check(
    "release-local: a dry run stops before publishing",
    at('if [ "$dry_run" = true ]') > 0 && at('if [ "$dry_run" = true ]') < at("gh release create"),
  );
  check(
    "release-local: signs from its own keychain, never by handing electron-builder CSC_LINK",
    /CSC_KEYCHAIN="\$keychain"[^\n]*electron-builder|CSC_KEYCHAIN="\$keychain"[^\n]*\\\n[^\n]*electron-builder/.test(code) &&
      at("unset CSC_LINK CSC_KEY_PASSWORD") > 0 &&
      at("unset CSC_LINK CSC_KEY_PASSWORD") < at("electron-builder --mac"),
  );
  check(
    "release-local: deletes the keychain and the temporary files on every exit",
    /trap cleanup EXIT/.test(code) && /delete-keychain "\$keychain"/.test(code) && /rm -rf "\$work"/.test(code),
  );
  check(
    "release-local: only from origin/main, unchanged",
    /git status --porcelain/.test(code) && /"\$\(git rev-parse HEAD\)" = "\$\(git rev-parse origin\/main\)"/.test(code),
  );
  check(
    "release-local: never reuses a released version",
    at('gh release view "$tag"') > 0 && at('gh release view "$tag"') < at("gh release create"),
  );

  const workflow = readFileSync(join(ROOT, "../../.github/workflows/deploy-desktop.yml"), "utf8");
  check(
    "the workflow refuses an older version than the latest release (a local release may be ahead of the run number)",
    /is older than the latest release/.test(workflow) && /sort -V/.test(workflow),
  );
}
