/**
 * The desktop suite. Offline, and with no Electron anywhere in it.
 *
 * Everything this app decides — whether that is a meeting, whether it may
 * record, what goes on the wire, what the menu bar says — is a pure function or
 * a reducer over injected collectors, precisely so that it can be checked here
 * rather than by holding a meeting. The parts that genuinely need macOS (the
 * four collectors, the audio capture) are behind interfaces with deterministic
 * fakes, and their *parsers* are checked against fixtures.
 *
 * Run it with `pnpm --filter @context/desktop test`, or `node test/test.mjs`.
 * Node's own TypeScript stripping runs `src/**\/*.ts` directly, so there is no
 * build step between this file and the code it is checking.
 */

import { runSettingsChecks } from "./settings.test.mjs";
import { runBlocklistChecks } from "./blocklist.test.mjs";
import { runConsentChecks } from "./consent.test.mjs";
import { runDetectionLoopChecks } from "./detectionLoop.test.mjs";
import { runOutboxChecks } from "./outbox.test.mjs";
import { runGatewayChecks } from "./gateway.test.mjs";
import { runControllerChecks } from "./controller.test.mjs";
import { runTrayChecks } from "./tray.test.mjs";
import { runPlatformChecks } from "./platform.test.mjs";
import { runContractChecks } from "./contract.test.mjs";

let failures = 0;
let skipped = 0;

function check(label, condition) {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
}

/**
 * A check that could not run, reported as itself.
 *
 * Used for exactly one thing today: the real detector is not in the tree yet.
 * A skip is not a pass and is printed as loudly as a failure, but it does not
 * fail the run — the desktop app is not the place where a missing sibling
 * package goes red.
 */
function skip(label, why) {
  skipped += 1;
  console.log(`SKIP  ${label}${why ? ` — ${why}` : ""}`);
}

runSettingsChecks(check);
runBlocklistChecks(check);
runConsentChecks(check);
await runDetectionLoopChecks(check);
runOutboxChecks(check);
await runGatewayChecks(check);
await runControllerChecks(check);
runTrayChecks(check);
runPlatformChecks(check);
await runContractChecks(check, skip);

console.log(
  failures
    ? `\n${failures} FAILURES${skipped ? `, ${skipped} skipped` : ""}`
    : `\nALL PASS${skipped ? ` (${skipped} skipped)` : ""}`,
);
process.exit(failures ? 1 : 0);
