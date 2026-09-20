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
import { runToolContractChecks } from "./toolContract.test.mjs";
import { runConnectionChecks } from "./connection.test.mjs";
import { runConnectChecks } from "./connect.test.mjs";
import { runApprovalChecks } from "./approval.test.mjs";
import { runAutoGrantChecks } from "./autoGrant.test.mjs";
import { runTokenStoreChecks } from "./tokenStore.test.mjs";
import { runCaptureWindowChecks } from "./captureWindow.test.mjs";
import { runTranscriberChecks } from "./transcriber.test.mjs";
import { runPlanChecks } from "./plan.test.mjs";
import { runLocalAgentChecks } from "./localAgent.test.mjs";
import { runTranscribeRequestChecks } from "./transcribeRequest.test.mjs";
import { runControllerChecks } from "./controller.test.mjs";
import { runSessionOrderChecks } from "./sessionOrder.test.mjs";
import { runTrayChecks } from "./tray.test.mjs";
import { runPlatformChecks } from "./platform.test.mjs";
import { runContractChecks } from "./contract.test.mjs";
import { runShellChecks } from "./shell.test.mjs";
import { runTrayOnlyChecks } from "./trayOnly.test.mjs";
import { runMirrorChecks } from "./mirror.test.mjs";
import { runConsoleBridgeChecks } from "./consoleBridge.test.mjs";
import { runPackagingChecks } from "./packaging.test.mjs";
import { runUpdatePolicyChecks } from "./updatePolicy.test.mjs";
import { runUpdaterBehaviorChecks } from "./updaterBehavior.test.mjs";
import { runUpdatePromptChecks } from "./updatePrompt.test.mjs";
import { runAppShellChecks } from "./appShell.test.mjs";
import { runImessageAppleTimeChecks } from "./imessageAppleTime.test.mjs";
import { runImessageAttributedBodyChecks } from "./imessageAttributedBody.test.mjs";
import { runImessagePathsChecks } from "./imessagePaths.test.mjs";
import { runImessagePermissionChecks } from "./imessagePermission.test.mjs";
import { runImessageCursorChecks } from "./imessageCursor.test.mjs";
import { runImessageReaderChecks } from "./imessageReader.test.mjs";
import { runImessageGatewayNotesChecks } from "./imessageGatewayNotes.test.mjs";
import { runImessageSyncChecks } from "./imessageSync.test.mjs";
import { runImessageSqliteChecks } from "./imessageSqlite.test.mjs";
import { runImessageServiceChecks } from "./imessageService.test.mjs";

let failures = 0;
let skipped = 0;

function check(label, condition) {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
}

/**
 * ONE SUITE, AND A THROW INSIDE IT REPORTED RATHER THAN FATAL.
 *
 * The gateway's own runner names this failure mode and answers it with a
 * discipline — *"every `.result` access below is optional-chained on
 * purpose"* — applied by hand, at every site, for ever. That discipline is
 * not holdable and was broken here: a `check` in the `transcribeRequest`
 * suite read `answer.speechEvidence.keptNoSpeechMax`, and the one edit it
 * existed to catch made that `null`.
 *
 * **What a throw costs, measured rather than assumed.** It is not the exit
 * code — the process does exit 1, and CI does go red. It is that the throw
 * unwinds past every suite queued behind it: in `apps/desktop` one such throw
 * took **1,129 of 1,780 checks** out of the run, and not one of them was
 * reported as failed, skipped, or missing. A run that silently stops being
 * 63% of itself, while showing red for one unrelated-looking reason, is the
 * worst shape a suite can fail in — worse than a plain failure, because the
 * number nobody reads is the one that moved.
 *
 * So a suite that throws is **one named failure**, and the suites behind it
 * still run. `report` is injectable only so this wrapper can be checked by
 * the suite it belongs to without printing a failure nobody should act on.
 */
function fail(label) {
  failures += 1;
  console.log(`FAIL  ${label}`);
}

async function suite(name, run, report = fail) {
  try {
    await run();
  } catch (error) {
    report(`${name} threw, so its remaining checks did not run — ${error?.message ?? error}`);
  }
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

/*
  AND THE WRAPPER'S OWN GUARD, BECAUSE A GUARD NOBODY HAS CHECKED IS NOT ONE.

  Two things, and the second is the whole point: a throwing suite becomes one
  named failure, **and the suite queued behind it still runs**. A wrapper that
  caught and re-threw would pass the first of these and fail the second, which
  is the shape that was already in the tree.

  Its own `report` so the deliberate throws below are not counted or printed —
  a FAIL line nobody should act on is how a suite teaches people to skim past
  FAIL lines.
*/
{
  const reported = [];
  const collect = (label) => reported.push(label);
  let secondRan = false;
  await suite("a suite that throws", () => {
    throw new Error("boom");
  }, collect);
  await suite("the one behind it", () => {
    secondRan = true;
  }, collect);
  check(
    "a suite that throws is one named failure, naming the suite and the reason",
    reported.length === 1 && reported[0].includes("a suite that throws") && reported[0].includes("boom")
  );
  check("...and the suite queued behind it still runs", secondRan === true);
  await suite("an async suite that rejects", async () => {
    throw new Error("later");
  }, collect);
  check("...and a rejected promise is caught the same way", reported.length === 2 && reported[1].includes("later"));
}

await suite("runSettingsChecks", () => runSettingsChecks(check));
await suite("runBlocklistChecks", () => runBlocklistChecks(check));
await suite("runConsentChecks", () => runConsentChecks(check));
await suite("runDetectionLoopChecks", () => runDetectionLoopChecks(check));
await suite("runOutboxChecks", () => runOutboxChecks(check));
await suite("runGatewayChecks", () => runGatewayChecks(check));
await suite("runToolContractChecks", () => runToolContractChecks(check));
await suite("runConnectionChecks", () => runConnectionChecks(check));
await suite("runConnectChecks", () => runConnectChecks(check));
await suite("runApprovalChecks", () => runApprovalChecks(check));
await suite("runAutoGrantChecks", () => runAutoGrantChecks(check));
await suite("runTokenStoreChecks", () => runTokenStoreChecks(check));
await suite("runCaptureWindowChecks", () => runCaptureWindowChecks(check));
await suite("runTranscriberChecks", () => runTranscriberChecks(check));
await suite("runPlanChecks", () => runPlanChecks(check));
await suite("runLocalAgentChecks", () => runLocalAgentChecks(check));
await suite("runTranscribeRequestChecks", () => runTranscribeRequestChecks(check));
await suite("runControllerChecks", () => runControllerChecks(check));
await suite("runSessionOrderChecks", () => runSessionOrderChecks(check));
await suite("runTrayChecks", () => runTrayChecks(check));
await suite("runPlatformChecks", () => runPlatformChecks(check));
await suite("runShellChecks", () => runShellChecks(check));
await suite("runTrayOnlyChecks", () => runTrayOnlyChecks(check));
await suite("runMirrorChecks", () => runMirrorChecks(check));
await suite("runUpdatePolicyChecks", () => runUpdatePolicyChecks(check));
await suite("runUpdaterBehaviorChecks", () => runUpdaterBehaviorChecks(check));
await suite("runUpdatePromptChecks", () => runUpdatePromptChecks(check));
await suite("runConsoleBridgeChecks", () => runConsoleBridgeChecks(check));
await suite("runContractChecks", () => runContractChecks(check, skip));
await suite("runPackagingChecks", () => runPackagingChecks(check));
await suite("runAppShellChecks", () => runAppShellChecks(check));
await suite("runImessageAppleTimeChecks", () => runImessageAppleTimeChecks(check));
await suite("runImessageAttributedBodyChecks", () => runImessageAttributedBodyChecks(check));
await suite("runImessagePathsChecks", () => runImessagePathsChecks(check));
await suite("runImessagePermissionChecks", () => runImessagePermissionChecks(check));
await suite("runImessageCursorChecks", () => runImessageCursorChecks(check));
await suite("runImessageReaderChecks", () => runImessageReaderChecks(check));
await suite("runImessageGatewayNotesChecks", () => runImessageGatewayNotesChecks(check));
await suite("runImessageSyncChecks", () => runImessageSyncChecks(check));
await suite("runImessageSqliteChecks", () => runImessageSqliteChecks(check, skip));
await suite("runImessageServiceChecks", () => runImessageServiceChecks(check, skip));

console.log(
  failures
    ? `\n${failures} FAILURES${skipped ? `, ${skipped} skipped` : ""}`
    : `\nALL PASS${skipped ? ` (${skipped} skipped)` : ""}`,
);
process.exit(failures ? 1 : 0);
