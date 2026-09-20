// The communications suite. `node test/test.mjs` — no framework, no
// dependencies, nothing to install. Same house style as the gateway's and the
// meetings suite: one `check` counter, one `runXChecks(check)` per module in a
// sibling `*.test.mjs`.
//
// What this package produces is somebody's mail, written into the same bucket
// as the notes they wrote themselves and read back by every AI client they
// have connected. So the checks that matter are not "does it render" — they
// are the ones a wrong answer would quietly cost somebody:
//
//   tenancy     no tenant, workspace or account id may appear in a key
//   injection   a sender may not add or change a frontmatter key
//   fencing     a sender may not end the region their words are quoted in
//   anchors     a link into a message survives a resync and a split
//   determinism the same day rendered twice is the same bytes
//
// Each sibling file carries its own sabotage record: what was deliberately
// broken and how many checks noticed. A guard nobody has checked is not a
// guard.

import { readFileSync } from "node:fs";

import { runAnchorChecks } from "./anchors.test.mjs";
import { runChatChecks } from "./chat.test.mjs";
import { runCalendarChecks } from "./calendar.test.mjs";
import { runContactChecks } from "./contacts.test.mjs";
import { runDestinationChecks } from "./destination.test.mjs";
import { runEstimateChecks } from "./estimate.test.mjs";
import { runNoteChecks } from "./note.test.mjs";
import { runPathChecks } from "./paths.test.mjs";

import * as index from "../src/index.js";
import {
  CHANNELS,
  CHANNEL_DAY_TYPE,
  CHANNEL_FOLDERS,
  CONTACTS_FOLDER,
  FRONTMATTER_KEYS,
  INBOX_FOLDER,
  PART_HEADER_RESERVE,
  PROTOCOL_VERSION,
  SPLIT_BYTE_THRESHOLD,
  TRUST,
} from "../src/protocol.js";

let failures = 0;
function check(label, cond) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
}

// -- the contract
//
// protocol.js is the single source of truth and the rest of this package does
// not edit it. These checks assert the implementation still agrees with it, so
// a change to the contract fails here rather than three surfaces later.
check("the protocol version is a number", typeof PROTOCOL_VERSION === "number");
check("the channel list is frozen, so a consumer cannot edit the contract", Object.isFrozen(CHANNELS));
check("...and so is the frontmatter key list", Object.isFrozen(FRONTMATTER_KEYS));
check("...and the folder map", Object.isFrozen(CHANNEL_FOLDERS));
check("every channel has a folder", CHANNELS.every((channel) => typeof CHANNEL_FOLDERS[channel] === "string"));
check(
  "...and no two channels share one",
  new Set(CHANNELS.map((channel) => CHANNEL_FOLDERS[channel])).size === CHANNELS.length
);
check(
  "the inbox is the one the bucket already has, not a second root",
  INBOX_FOLDER === "0-inbox" && CONTACTS_FOLDER.startsWith("0-inbox/")
);
check(
  "email is where the forwarded captures already are",
  CHANNEL_FOLDERS.email === "0-inbox/email"
);
check("a channel-day note says what it is", CHANNEL_DAY_TYPE === "channel-day");
check("there is no trusted value; a channel is a channel strangers write into", TRUST === "untrusted");
check("the split threshold leaves room for the header it reserves", SPLIT_BYTE_THRESHOLD > PART_HEADER_RESERVE);
check(
  "every frontmatter key is a plain lowercase word, never derived from a message",
  FRONTMATTER_KEYS.every((key) => /^[a-z][a-z-]*$/.test(key))
);
check("...and there are no duplicates in the list", new Set(FRONTMATTER_KEYS).size === FRONTMATTER_KEYS.length);

/*
  The non-negotiable, asserted against the source rather than against a run:
  tenancy is bucket-level, never prefix-level. A key built from a workspace id,
  a user id or an account id is the one change to this package that could not
  be undone for an existing workspace, so it is checked the way the meetings
  package checks its own — by reading the files.

  Comments are stripped first, because every file here *discusses* tenancy at
  length and a check that read prose would fail on the paragraph explaining why
  the thing it forbids is forbidden. `scripts/check-gateway-imports.mjs` holds
  the repository's other copy of this stripper and is deliberately not imported:
  that file runs its checks at import time, so importing it here would run the
  gateway's import audit inside this suite and fail on a working tree. The two
  copies are held apart the way two copies of a rule always are here — this one
  has a self-test directly below it.
*/
function stripComments(source) {
  let out = "";
  let state = "code";
  let quote = "";
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") { state = "line"; i += 1; continue; }
      if (c === "/" && next === "*") { state = "block"; i += 1; continue; }
      if (c === '"' || c === "'" || c === "`") { state = "string"; quote = c; }
      out += c;
      continue;
    }
    if (state === "string") {
      if (c === "\\") { out += c + (next ?? ""); i += 1; continue; }
      if (c === quote) { state = "code"; quote = ""; }
      out += c;
      continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; }
      continue;
    }
    if (c === "*" && next === "/") { state = "code"; i += 1; }
  }
  return out;
}

check(
  "the comment stripper keeps code and drops prose, so the checks below check something",
  stripComments("const a = 1; // tenants/") === "const a = 1; " &&
    stripComments("/* workspaceId */const b = 2;") === "const b = 2;" &&
    stripComments('const c = "http://x"; // y') === 'const c = "http://x"; '
);

const SOURCES = ["protocol.js", "paths.js", "anchors.js", "note.js", "contacts.js", "destination.js", "estimate.js", "index.js"].map((name) =>
  stripComments(readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8"))
);
check(
  "no source in this package knows what a tenant, a workspace or a user is",
  !SOURCES.some((source) => /tenants\/|workspaces\/|workspaceId|userId/.test(source))
);
check(
  "...and none of them does I/O or imports a provider",
  !SOURCES.some((source) => /\bfetch\(|node:|require\(|googleapis|gmail/i.test(source))
);
/*
  `jest-environment-jsdom` does not put `TextEncoder`/`TextDecoder` on the
  global object — measured directly, not assumed — so a module that
  constructs one at load time throws the moment anything imports this
  package under it, whether or not the caller ever reaches the function that
  needed it. That was a real regression: `apps/mobile`'s console imports
  `parseChannelDayMessages` to *read* a day back, never `utf8Length`, and it
  broke eight jsdom-backed test suites anyway because `note.js` built its
  encoder at the top of the file. Checked at the source level, against every
  file in the package, so the same mistake in a file added later fails here
  rather than in whichever app happens to import it under jsdom first.
*/
/*
  A guard nobody has checked is not a guard. The pattern below is what this
  check used to be, verbatim, and it looked like it caught the class it
  names. It does not: it requires the literal keyword `const`, so
  `let cachedEncoder = new TextEncoder();` at module scope — a plain rewrite
  of this very fix, and one nobody would flag in review as behaving any
  differently — sails through unnoticed. Asserted against the checker
  directly, not against a hypothetical: this is the self-test "a guard nobody
  has checked is not a guard" asks for, and it is what turned up the gap
  rather than a promise to look harder.
*/
const OLD_TEXT_CODEC_PATTERN = /^(export )?const \w+ = new Text(En|De)coder\(\)/m;
check(
  "the retired pattern missed a module-scope `let`, which is the sabotage this replaces",
  !OLD_TEXT_CODEC_PATTERN.test("let cachedEncoder = new TextEncoder();\n")
);

/*
  Still anchored to "no leading whitespace" on purpose, not loosened to
  "anywhere in the file": every function body in this package is indented at
  least one level (there is no other module-scope construct here that isn't),
  so a bare `^` is what tells a real top-level statement apart from the exact
  lazy pattern `note.js` uses now — `if (x === null) x = new TextEncoder();`
  inside a function, reassignment rather than declaration, which must keep
  passing or this check starts failing on the very fix it exists to protect.
*/
const TEXT_CODEC_AT_MODULE_SCOPE = /^(export )?(const|let|var) \w+ = new Text(En|De)coder\(\)/m;
check(
  "the codec guard, unlike its predecessor, catches a module-scope `let`",
  TEXT_CODEC_AT_MODULE_SCOPE.test("let cachedEncoder = new TextEncoder();\n")
);
check(
  "...and a module-scope `var`",
  TEXT_CODEC_AT_MODULE_SCOPE.test("var cachedEncoder = new TextEncoder();\n")
);
check(
  "...and still leaves the real lazy-singleton pattern alone",
  !TEXT_CODEC_AT_MODULE_SCOPE.test(
    "let cachedEncoder = null;\nfunction encoder() {\n  if (cachedEncoder === null) cachedEncoder = new TextEncoder();\n  return cachedEncoder;\n}\n"
  )
);
check(
  "no source builds a TextEncoder or TextDecoder outside a function body",
  !SOURCES.some((source) => TEXT_CODEC_AT_MODULE_SCOPE.test(source))
);

// -- the public surface
//
// One import for the gateway and for the control plane; anything missing here
// is a consumer that has to reach into a file path instead.
for (const name of [
  "CHANNELS",
  "CHANNEL_FOLDERS",
  "FRONTMATTER_KEYS",
  "SPLIT_BYTE_THRESHOLD",
  "channelDayNotePath",
  "channelFolder",
  "chooseMailboxSlug",
  "contactNotePath",
  "contactSlug",
  "isChannelDayNotePath",
  "isContactNotePath",
  "messageAnchor",
  "threadKey",
  "spaceKey",
  "renderChannelDayNote",
  "parseChannelDayNote",
  "planChannelDay",
  "groupIntoSpaces",
  "parseChannelDayPath",
  "renderContactNote",
  "parseContactNote",
  "canAutoMerge",
  "suggestMerge",
  "activityLink",
  "estimateMailboxBackfill",
  "estimateBackfillWindows",
  "normalizeDestinationFolder",
  "destinationPattern",
  "resolveDestinationPattern",
  "suggestDestinationFolders",
]) {
  check(`index re-exports ${name}`, index[name] !== undefined);
}
check(
  "index exports no per-message note helper — a day is one file",
  !Object.keys(index).some((name) => /messageNotePath|perMessage|messageNote\b/i.test(name))
);

// -- the modules, in dependency order
runPathChecks(check);
runAnchorChecks(check);
runNoteChecks(check);
runChatChecks(check);
runContactChecks(check);
runDestinationChecks(check);
runEstimateChecks(check);
// Calendar carries its own contract, public-surface and purity checks — see
// `runCalendarChecks` in `calendar.test.mjs` — rather than duplicating them
// into the assertions above, which are about `protocol.js`'s channel-day
// contract specifically.
runCalendarChecks(check);

console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
