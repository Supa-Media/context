/**
 * The Linux build (Dev, 2026-11-03): an AppImage and a `.deb` for x64 and
 * arm64, built by `deploy-desktop-linux.yml` and attached to the release the
 * Mac job creates. Checked as text, like the rest of this suite: what breaks
 * here breaks silently, as a 404 behind `context.lc/download/linux` or a
 * release whose Linux file is another version's.
 *
 * Sabotage record: putting `${version}` back in the AppImage's name, dropping
 * `needs.build.outputs.published` from `publish-linux`'s `if:`, removing the
 * version comparison from the attach script, and launching the unpacked
 * directory instead of the installed `.deb` each fail a check below.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, BUILDER } from "./fixtures.mjs";
import { withoutYamlComments } from "../appShell.test.mjs";

const read = (path) => readFileSync(join(ROOT, path), "utf8");

export async function runLinuxBuildChecks(check) {
  const blocks = withoutYamlComments(BUILDER).split(/\n(?=\S)/);
  const block = (name) => blocks.find((b) => b.startsWith(`${name}:`)) ?? "";
  const LINUX = block("linux");
  const ROUTER = read("../../infra/router/src/download.ts");

  check("it builds an AppImage and a .deb for Linux", /target:\s*AppImage/.test(LINUX) && /target:\s*deb/.test(LINUX));
  check("...for x64 and arm64, so an arm64 VM is covered too", (LINUX.match(/- arm64/g) ?? []).length === 2 && (LINUX.match(/- x64/g) ?? []).length === 2);
  check(
    "THE LINUX FILE NAMES CARRY NO VERSION, so context.lc/download/linux always means the newest",
    /artifactName:\s*\$\{productName\}-linux-\$\{arch\}\.\$\{ext\}/.test(block("appImage")) &&
      /artifactName:\s*\$\{productName\}-linux-\$\{arch\}\.\$\{ext\}/.test(block("deb")),
  );
  check(
    "...and the router points at exactly the names electron-builder gives them (x86_64 for an AppImage, amd64 for a .deb)",
    ["Context-linux-x86_64.AppImage", "Context-linux-arm64.AppImage", "Context-linux-amd64.deb", "Context-linux-arm64.deb"].every((name) =>
      ROUTER.includes(name),
    ),
  );
  const PKG = JSON.parse(read("package.json"));
  check("package.json has the homepage and author a .deb cannot be built without", Boolean(PKG.homepage) && Boolean(PKG.author));

  const MAIN = withoutYamlComments(read("../../.github/workflows/deploy-desktop.yml"));
  const REUSABLE = withoutYamlComments(read("../../.github/workflows/deploy-desktop-linux.yml"));
  const ATTACH = read("build/attach-linux-release.sh");

  check(
    "deploy-desktop.yml calls the Linux workflow beside the Mac job, not after it",
    /\n  linux:\n    uses: \.\/\.github\/workflows\/deploy-desktop-linux\.yml/.test(MAIN) &&
      !/\n  linux:\n(?:    .*\n)*?    needs:/.test(MAIN),
  );
  check(
    "THE LINUX FILES ARE ATTACHED ONLY TO A RELEASE THE MAC JOB REPORTS IT CREATED",
    /needs: \[build, linux\]\n    if: needs\.build\.outputs\.published == 'true'/.test(MAIN) &&
      /published: \$\{\{ steps\.publish\.outputs\.published \}\}/.test(MAIN) &&
      /echo "published=true" >> "\$GITHUB_OUTPUT"/.test(MAIN),
  );
  check(
    "...and never to a different version than the one the Linux build stamped",
    /"\$MAC_VERSION" != "\$LINUX_VERSION"[\s\S]*exit 1[\s\S]*gh release upload "v\$MAC_VERSION"/.test(ATTACH),
  );
  check(
    "the Linux version rule is the Mac one: major.minor.<run number> only when publish was requested",
    /PUBLISH_REQUESTED === "true"/.test(REUSABLE) && /version = `\$\{major\}\.\$\{minor\}\.\$\{run\}`/.test(REUSABLE),
  );
  check(
    "THE LAUNCH CHECK INSTALLS THE .DEB AND RUNS THE INSTALLED APP — the package, not the unpacked directory",
    /apt-get install -y -qq \.\/release\/Context-linux-amd64\.deb/.test(REUSABLE) &&
      /\/opt\/Context\/context --smoke/.test(REUSABLE) &&
      !/linux-unpacked/.test(REUSABLE),
  );
  check(
    "...and it fails on a crash string or a missing verdict, not only on a non-zero exit",
    /Uncaught Exception\|A JavaScript error occurred/.test(REUSABLE) && /the app started, opened a window/.test(REUSABLE),
  );
  check(
    "the Linux workflow is only ever called, never triggered by a push or a pull request",
    /^on:\n  workflow_call:/m.test(REUSABLE) && !/^\s*(push|pull_request):/m.test(REUSABLE),
  );
}
