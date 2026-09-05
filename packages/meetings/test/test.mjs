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
import { readFileSync } from "node:fs";

import {
  CLIENT_EVENT_TYPES,
  DEVICE_PLATFORMS,
  ERRORS,
  GATEWAY_EVENT_TYPES,
  MEETING_SOURCE_KINDS,
  MEETING_TRANSITIONS,
  PROTOCOL_VERSION,
  ROUTES,
  TRANSCRIPT_CHANNELS,
  isMeetingId,
} from "../src/protocol.js";

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
check(
  "a failed recording can be restarted, or written out with what it captured",
  MEETING_TRANSITIONS.failed.join(",") === "recording,finalizing"
);
check(
  "a meeting nobody recorded can still be finalized, so typed notes are never stranded",
  MEETING_TRANSITIONS.idle.includes("finalizing")
);
check(
  "and a finalize the gateway has not answered can be taken back to recording",
  MEETING_TRANSITIONS.finalizing.includes("recording")
);
check("every wire error is a distinct string", new Set(Object.values(ERRORS)).size === Object.keys(ERRORS).length);
check(
  "`written` is the gateway's own event and is not one a client may send",
  !CLIENT_EVENT_TYPES.includes("written") && GATEWAY_EVENT_TYPES.includes("written")
);
check(
  "...and the two lists together are the whole union, so nothing is unclassified",
  [...CLIENT_EVENT_TYPES, ...GATEWAY_EVENT_TYPES].sort().join(",") ===
    [
      "attendee",
      "end",
      "enhanced",
      "fail",
      "flag",
      "notes",
      "pause",
      "resume",
      "segment",
      "segments",
      "source",
      "start",
      "title",
      "written",
    ].join(",")
);
check("the collection route is a path", ROUTES.sessions.startsWith("/meetings/"));
check("reading one session puts the id in the path", ROUTES.session("mtg_x") === `${ROUTES.sessions}/mtg_x`);
check(
  "...so the collection and one session are not the same route",
  ROUTES.session("mtg_x") !== ROUTES.sessions
);
check("the per-session routes are built from the id", ROUTES.segments("mtg_x").endsWith("/mtg_x/segments"));
check(
  "...and hang off the one-session route rather than restating it",
  ["segments", "notes", "finalize"].every((name) =>
    ROUTES[name]("mtg_x").startsWith(`${ROUTES.session("mtg_x")}/`)
  )
);
/*
  The runtime lists and the JSDoc unions are two statements of one fact, and the
  whole reason the lists exist is that three consumers were each keeping a third
  copy. So this reads the union out of protocol.js's own source and compares it
  to what the module exports: a union member added without touching the array —
  or the other way round — fails here rather than as a segment quietly relabelled
  `mixed` on somebody's phone.
*/
const PROTOCOL_SOURCE = readFileSync(new URL("../src/protocol.js", import.meta.url), "utf8");

/** The `"a"|"b"|"c"` union declared for `@property ... <name>`, as an array. */
function unionFor(property) {
  const declaration = new RegExp(`@property \\{([^}]*)\\} ${property}\\b`).exec(PROTOCOL_SOURCE);
  if (declaration === null) return [];
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

for (const [property, exported] of [
  ["kind", MEETING_SOURCE_KINDS],
  ["channel", TRANSCRIPT_CHANNELS],
  ["platform", DEVICE_PLATFORMS],
]) {
  const declared = unionFor(property);
  check(`the ${property} union is not empty, so this check is checking something`, declared.length > 0);
  check(
    `...and the exported list is exactly the ${property} union, in order`,
    declared.join(",") === [...exported].join(",")
  );
  check(`...frozen, so a consumer cannot edit the contract's list`, Object.isFrozen(exported));
}

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
