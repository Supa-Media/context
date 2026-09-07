/**
 * The desktop-bridge suite. `node --experimental-strip-types test/test.mjs` —
 * no framework, no dependencies, nothing to install.
 *
 * Same house style as the gateway's and the meetings core's: one `check`
 * counter, one `runXChecks(check)` per module in a sibling `*.test.mjs`, and a
 * sabotage record in each file saying what was deliberately broken and how many
 * checks noticed. A guard nobody has checked is not a guard.
 *
 * What is worth checking in a package that is mostly types: the two things a
 * compiler cannot hold up.
 *
 *   honesty       a capability nobody answered reads as `false`, everywhere
 *   the boundary  no member of this surface can hand the page a credential
 *   compatibility a shell older than the UI still works; a newer one degrades
 *   detachment    every subscription can be unsubscribed, or React leaks
 *
 * Run it with `pnpm --filter @context/desktop-bridge test`. Node's own
 * TypeScript stripping runs `src/*.ts` directly, so there is no build step
 * between this file and the code it is checking.
 */

import { runBridgeAsyncChecks, runBridgeChecks } from "./bridge.test.mjs";
import { runContractChecks } from "./contract.test.mjs";
import { runLayoutChecks } from "./layout.test.mjs";

import * as index from "../src/index.ts";

let failures = 0;
function check(label, condition) {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
}

// -- the public surface
//
// One import for Metro and for Electron. Anything missing here is a consumer
// that has to reach into a file path instead — which is how two copies of a
// contract start.
for (const name of [
  "BRIDGE_VERSION",
  "MIN_BRIDGE_VERSION",
  "BRIDGE_CHANNELS",
  "BRIDGE_CHANNEL_NAMES",
  "CAPABILITY_NAMES",
  "MEETING_WRITE_KINDS",
  "NO_CAPABILITIES",
  "TRAY_COMMANDS",
  "capabilitiesFrom",
  "getDesktopBridge",
  "inspectDesktopBridge",
  "isSupportedBridgeVersion",
  "SHELL_TITLE_BAND_PX",
  "SHELL_TRAFFIC_LIGHTS",
]) {
  check(`index exports ${name}`, index[name] !== undefined);
}
check(
  "the index exports nothing credential-shaped",
  !Object.keys(index).some((name) => /token|secret|credential|password/i.test(name)),
);
check(
  "the fake shell is not on the index — it is imported from `/fake` so it cannot reach an app bundle",
  !Object.keys(index).some((name) => /fake/i.test(name)),
);

runContractChecks(check);
runBridgeChecks(check);
await runBridgeAsyncChecks(check);
runLayoutChecks(check, index);

console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
