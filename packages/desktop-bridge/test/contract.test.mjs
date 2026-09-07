/**
 * THE SHAPE — `src/contract.ts`.
 *
 * What is worth checking about a type file, given that the types themselves are
 * gone by the time this runs: the *values* the contract carries, and the
 * promises its prose makes that a compiler cannot keep.
 *
 * Three of those promises are load-bearing:
 *
 *  - **Everything is `false` by default.** A capability answered by a shell
 *    that has never heard of it must read as "no", because a screen that shows
 *    a system-audio switch on a build macOS will not give a loopback tap to is
 *    the one thing `docs/decisions/meetings.md` forbids by name.
 *  - **Only `true` is true.** `capabilitiesFrom` reads values rather than
 *    spreading them, so `systemAudio: "yes"` from a confused shell is a no.
 *  - **No credential crosses.** The declared surface carries no member whose
 *    name is token-shaped. `bridge.test.mjs` enforces the same rule at runtime
 *    against an object; this one reads the interface, because a member added to
 *    the *type* is how one would arrive.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole package suite.
 *
 *   `capabilitiesFrom` spreading the answer instead of reading each key         3
 *   `capabilitiesFrom` handing back `NO_CAPABILITIES` itself rather than a copy 2
 *   `MIN_BRIDGE_VERSION` raised above `BRIDGE_VERSION`                         38
 *   `NO_CAPABILITIES` not frozen                                               1
 *   a `getToken(): Promise<string>` added to the `DesktopBridge` interface      1
 *   two channel constants given the same string                                 1
 *
 * The 38 is worth reading rather than counting: raising the floor above the
 * ceiling makes this bundle refuse every shell in existence, which is what a
 * "tidy-up" that collapsed the two constants into one would do the first time
 * the version moved. It fails loudly, which is the right direction.
 *
 * The first row was measured at **0** on the first attempt, and the reason is
 * recorded because it is a trap this house has met before: the check mutated
 * the answer to prove it was a copy, and a frozen answer makes that assignment
 * *throw* in a module rather than return false — so the suite died and `grep -c
 * FAIL` counted nothing. A check whose failure mode is a crash is a check that
 * reports zero. It now refuses inside a `try`.
 */

import { readFileSync } from "node:fs";

import {
  BRIDGE_CHANNEL_NAMES,
  BRIDGE_CHANNELS,
  BRIDGE_VERSION,
  CAPABILITY_NAMES,
  MIN_BRIDGE_VERSION,
  NO_CAPABILITIES,
  MEETING_WRITE_KINDS,
  TRAY_COMMANDS,
  capabilitiesFrom,
} from "../src/index.ts";

const CONTRACT_SOURCE = readFileSync(new URL("../src/contract.ts", import.meta.url), "utf8");

/** Declaration lines only: anything starting a comment is prose, not surface. */
function declaredMemberNames(source) {
  const names = [];
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("*") || line.startsWith("//") || line.startsWith("/*")) {
      continue;
    }
    const match = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?]?\s*[(:]/.exec(line);
    if (match !== null) names.push(match[1]);
  }
  return names;
}

export function runContractChecks(check) {
  // -- versions

  check("the bridge version is an integer", Number.isInteger(BRIDGE_VERSION));
  check("...and at least 1, so `0` can mean 'unreadable'", BRIDGE_VERSION >= 1);
  check(
    "the oldest supported bridge is not newer than this bundle's own",
    MIN_BRIDGE_VERSION <= BRIDGE_VERSION,
  );
  check("...and is itself a real version", Number.isInteger(MIN_BRIDGE_VERSION) && MIN_BRIDGE_VERSION >= 1);

  // -- capabilities

  check("`NO_CAPABILITIES` is frozen", Object.isFrozen(NO_CAPABILITIES));
  check(
    "every capability defaults to false",
    Object.values(NO_CAPABILITIES).every((value) => value === false),
  );
  check(
    "...and the default names exactly the capabilities the contract lists",
    [...CAPABILITY_NAMES].sort().join(",") === Object.keys(NO_CAPABILITIES).sort().join(","),
  );
  check("the capability list is frozen", Object.isFrozen(CAPABILITY_NAMES));
  check(
    "system audio is one of them, because it is the one the desktop exists for",
    CAPABILITY_NAMES.includes("systemAudio"),
  );

  check(
    "a shell that answered nothing can do nothing",
    Object.values(capabilitiesFrom(undefined)).every((value) => value === false),
  );
  for (const rubbish of [null, 42, "yes", [], () => {}]) {
    check(
      `...and so does one that answered ${JSON.stringify(rubbish) ?? typeof rubbish}`,
      Object.values(capabilitiesFrom(rubbish)).every((value) => value === false),
    );
  }
  check(
    "a capability answered `true` is true",
    capabilitiesFrom({ systemAudio: true }).systemAudio === true,
  );
  check(
    "...and nothing else it did not answer is",
    capabilitiesFrom({ systemAudio: true }).mic === false,
  );
  check(
    "a truthy non-boolean is NOT a capability — only `true` is",
    capabilitiesFrom({ systemAudio: "yes", mic: 1 }).systemAudio === false &&
      capabilitiesFrom({ systemAudio: "yes", mic: 1 }).mic === false,
  );
  check(
    "a key the contract does not name is dropped rather than carried",
    !("wiretap" in capabilitiesFrom({ wiretap: true })),
  );
  check(
    "the answer is a fresh object, so a caller cannot edit the default for everybody",
    (() => {
      const first = capabilitiesFrom({ mic: true });
      if (first === NO_CAPABILITIES) return false;
      // A frozen answer is the shared default handed out under another name:
      // this assignment throws in a module (strict mode), which is a refusal
      // rather than a crash — the suite must not die on somebody else's bug.
      try {
        first.mic = false;
      } catch {
        return false;
      }
      return capabilitiesFrom({ mic: true }).mic === true && NO_CAPABILITIES.mic === false;
    })(),
  );

  // -- channels

  check("the channel names are frozen", Object.isFrozen(BRIDGE_CHANNELS));
  check(
    "every channel is namespaced, so nothing collides with another app's",
    Object.values(BRIDGE_CHANNELS).every((name) => name.startsWith("context:")),
  );
  check(
    "no two channels share a string — one that did would be answered by the wrong handler",
    new Set(Object.values(BRIDGE_CHANNELS)).size === Object.keys(BRIDGE_CHANNELS).length,
  );
  check(
    "the origin and shell channels keep the names the shell already used",
    BRIDGE_CHANNELS.origin === "context:console-origin" &&
      BRIDGE_CHANNELS.shell === "context:console-shell",
  );
  check(
    "the enumerable list is every channel, so a sender guard can cover all of them",
    BRIDGE_CHANNEL_NAMES.length === Object.keys(BRIDGE_CHANNELS).length,
  );
  check("...and it is frozen too", Object.isFrozen(BRIDGE_CHANNEL_NAMES));
  check(
    "there is no channel that reads a credential",
    !BRIDGE_CHANNEL_NAMES.some((name) => /token|secret|credential|password/i.test(name)),
  );

  // -- tray

  check("the tray commands are frozen", Object.isFrozen(TRAY_COMMANDS));
  check("...and distinct", new Set(TRAY_COMMANDS).size === TRAY_COMMANDS.length);
  check(
    "record, pause, resume and end are all reachable from the menu bar",
    ["record", "pause", "resume", "end"].every((command) => TRAY_COMMANDS.includes(command)),
  );

  // -- the meeting write, which is the version-2 addition
  //
  // Four kinds because there are four routes, and they are the protocol's own
  // names rather than a second vocabulary: a `write` with `kind: "segments"` is
  // `POST /meetings/sessions/:id/segments`. A fifth word here would be a route
  // the gateway does not serve.

  check("the write kinds are frozen", Object.isFrozen(MEETING_WRITE_KINDS));
  check("...and distinct", new Set(MEETING_WRITE_KINDS).size === MEETING_WRITE_KINDS.length);
  check(
    "they are the meetings protocol's four routes, and only those",
    MEETING_WRITE_KINDS.join() === "session,segments,notes,finalize",
  );
  check(
    "the write carries a context *name*, never a path the page composed",
    /context: string \| null/.test(CONTRACT_SOURCE),
  );
  check(
    "the ack can say parked, so a refusal is not retried against somebody's quota",
    /rejected: \{ code: string; message: string \} \| null/.test(CONTRACT_SOURCE),
  );

  // -- the credential rule, read off the declared surface
  //
  // The runtime check in `bridge.ts` refuses an object carrying one of these.
  // This one refuses the *type* carrying one, which is where it would be
  // written down first.

  const declared = declaredMemberNames(CONTRACT_SOURCE);
  check("the declaration scan found members at all, so it is checking something", declared.length > 20);
  check(
    "no member of the contract is credential-shaped",
    !declared.some((name) =>
      /token|secret|credential|password|authorization|cookie/i.test(name),
    ),
  );
  check(
    "...and the scan would notice one",
    declaredMemberNames("  getToken(): Promise<string>;").includes("getToken"),
  );
  check(
    "...while prose about `getToken` is not a member",
    declaredMemberNames(" * There is no getToken: here and there must not be").length === 0,
  );

  // -- what the contract carries and what it must never carry

  check(
    "the contract declares no field that could hold audio",
    !declared.some((name) => /audioBase64|blob|bytes|filePath|samples/i.test(name)),
  );
}
