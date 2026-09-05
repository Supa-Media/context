// The meetings suite. `node test/test.mjs` — no framework, no dependencies,
// nothing to install. Same house style as the gateway's suite: one `check`
// counter, one `runXChecks(check)` per module in a sibling `*.test.mjs`.
//
// A meeting recorder is a piece of software people point at their own
// conversations, and the note it produces lands in a bucket they own and sync
// to their vault. So the checks that matter here are not "does it render" —
// they are the ones a wrong answer would quietly cost somebody:
//
//   replay        an offline phone re-sends its whole log; twice must equal once
//   tenancy       no `tenants/<id>/` may ever appear in a customer's bucket
//   their notes   `## My notes` is theirs, verbatim, whatever they typed in it
//   flicker       one bad poll must not start or stop a recording
//
// Each sibling file carries its own sabotage record: what was deliberately
// broken and how many checks noticed. A guard nobody has checked is not a
// guard.

import { runDetectChecks } from "./detect.test.mjs";
import { runEnhanceChecks } from "./enhance.test.mjs";
import { runNoteChecks } from "./note.test.mjs";
import { runPathChecks } from "./paths.test.mjs";
import { runSessionChecks } from "./session.test.mjs";
import { runTranscriptChecks } from "./transcript.test.mjs";

import * as index from "../src/index.js";
import { ERRORS, MEETING_TRANSITIONS, PROTOCOL_VERSION, ROUTES, isMeetingId } from "../src/protocol.js";

let failures = 0;
function check(label, cond) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
}

// -- the contract
//
// protocol.js is the single source of truth and this package does not edit it.
// These checks assert that the implementation still agrees with it, so a change
// to the contract fails here rather than three surfaces later.
check("the protocol version is a number", typeof PROTOCOL_VERSION === "number");
check("every state in the transition table can be reached or is terminal", (() => {
  const states = Object.keys(MEETING_TRANSITIONS);
  const reachable = new Set(["idle"]);
  for (const from of states) for (const to of MEETING_TRANSITIONS[from]) reachable.add(to);
  return states.every((state) => reachable.has(state));
})());
check("every transition target is itself a known state", Object.values(MEETING_TRANSITIONS).every((targets) => targets.every((target) => target in MEETING_TRANSITIONS)));
check("complete is terminal", MEETING_TRANSITIONS.complete.length === 0);
check("failed can only be restarted", MEETING_TRANSITIONS.failed.join(",") === "recording");
check("every wire error is a distinct string", new Set(Object.values(ERRORS)).size === Object.keys(ERRORS).length);
check("the session route is a path", ROUTES.session.startsWith("/meetings/"));
check("the per-session routes are built from the id", ROUTES.segments("mtg_x").endsWith("/mtg_x/segments"));
check("isMeetingId refuses the ambiguous letters", !isMeetingId(`mtg_${"i".repeat(20)}`) && !isMeetingId(`mtg_${"l".repeat(20)}`));
check("...and anything of the wrong length", !isMeetingId(`mtg_${"a".repeat(19)}`) && !isMeetingId(`mtg_${"a".repeat(21)}`));

// -- the public surface
//
// One import for the Worker, for Metro and for Electron; anything missing here
// is a consumer that has to reach into a file path instead.
for (const name of [
  "createSession",
  "applyEvent",
  "applyLog",
  "newMeetingId",
  "mergeSegments",
  "groupIntoTurns",
  "slugifyTitle",
  "meetingNotePath",
  "renderMeetingNote",
  "parseMeetingNote",
  "splitTranscript",
  "detect",
  "nextDetectorState",
  "buildEnhancementRequest",
  "applyEnhancement",
  "PROTOCOL_VERSION",
  "MEETING_TRANSITIONS",
  "ROUTES",
]) {
  check(`index re-exports ${name}`, index[name] !== undefined);
}
check(
  "index does not export a transcript path helper — one meeting is one file",
  !Object.keys(index).some((name) => /transcriptPath|transcriptFile|sidecar/i.test(name))
);

// -- the modules, in dependency order
runTranscriptChecks(check);
runSessionChecks(check);
runPathChecks(check);
runNoteChecks(check);
runDetectChecks(check);
runEnhanceChecks(check);

console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
