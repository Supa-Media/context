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
import { runContactChecks } from "./contacts.test.mjs";
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
  be undone for an existing brain, so it is checked the way the meetings
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

const SOURCES = ["protocol.js", "paths.js", "anchors.js", "note.js", "contacts.js", "index.js"].map((name) =>
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
  "renderChannelDayNote",
  "parseChannelDayNote",
  "planChannelDay",
  "parseChannelDayPath",
  "renderContactNote",
  "parseContactNote",
  "canAutoMerge",
  "suggestMerge",
  "activityLink",
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
runContactChecks(check);

console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
