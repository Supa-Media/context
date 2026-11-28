/**
 * A note path as every tool's path argument is normalized (`normalizePath`),
 * and a path segment as the storage layer will finally read it
 * (`decodeSegment`): pure rules the gateway (`apps/mcp/src/notes/paths.js`,
 * `store/index.js`, which re-export them) and Tex both read, so Tex reaches
 * neither gateway module. Moved verbatim.
 */
"use strict";

/**
 * A path segment as the storage layer will finally read it.
 *
 * Exported because the gateway's `normalizePath` needs the same answer at its
 * own door: `encodeRfc3986` leaves "." unencoded, so `%2e%2e` reaches storage
 * as `..` while containing neither dot literally. The DECODING is the subtle
 * half and lives here once; each layer still states its own segment rule, so
 * neither is only covered by the other.
 */
function decodeSegment(segment) {
  if (!segment.includes("%")) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape stays literal; it is encoded again on the way out.
    return segment;
  }
}

function normalizePath(p) {
  if (typeof p !== "string") return null;
  // A trailing slash is stripped rather than rejected. "1-projects/" is a
  // natural way to name a folder — scope_info and search_notes get asked it
  // routinely — and leaving it on produces an empty final segment that the
  // storage adapter refuses, surfacing a reasonable question as an internal
  // error. move_folder already stripped it locally; doing it here covers every
  // caller.
  const clean = p
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .trim();
  if (!clean || clean.length > 512) return null;
  // No control characters, and a newline is the one that mattered.
  //
  // `privacy.md` is a line-oriented format and `renderPrivacyRulesBlock`
  // interpolates a path into it unescaped. A path carrying `\n` therefore wrote
  // its own extra rules: `write_note` with
  // `path: "1-projects/secret.md: team\n  1-projects/junk.md"` and
  // `visibility: "private"` rendered a SECOND override for the real note, which
  // the parser reads after the first and lets win — publishing a private note
  // while the call declared `private`, so `isPublishing` was false and no
  // confirmation was asked for. `set_folder_visibility` defeated its own impact
  // report the same way, since `visibilityOf` matched the injected prefix
  // exactly and reported `newly_team_visible_notes: 0`.
  //
  // Rejected here, at the one place every tool's path argument arrives, rather
  // than escaped at the renderer: a path with a newline in it is not a path any
  // store can hold, so there is nothing to preserve. `persistExactVisibility`
  // round-trips the rendered rule as well — see `writableAsRule` in the control
  // plane for why a blacklist alone is a guess about a parser.
  if (/[\u0000-\u001F\u007F]/.test(clean)) return null;
  /*
    "." AND ".." ARE SEGMENTS, NOT SUBSTRINGS — AND `%2e` IS BOTH.

    A "." segment is rejected here on purpose. It was previously caught only as
    a side effect of isPlumbing() hiding dot-prefixed folders, which is not a
    path rule and could be relaxed without anyone noticing.

    ".." used to be refused as a SUBSTRING, which is a different rule and was
    wrong in both directions. It refused a file the gateway could see:
    `v1..v2.md` is an ordinary S3 key, and the customer's bucket is written
    directly by Obsidian sync, rclone and the provider console — the three
    writers `writableAsRule` names — so a name with two dots in it arrives
    without the gateway's involvement. `list_notes` listed it and
    `search_notes` printed its body while every path-taking tool answered
    "invalid path", which left a note its owner could not make private.

    And it let one through. `encodeRfc3986` leaves "." unencoded, so `%2e%2e`
    contains no ".." literally: it passed this door, reached `assertSafeKey` at
    the storage boundary, and came back as a JSON-RPC **internal error** where
    its plain twin came back as a tool error. The traversal was refused either
    way; a refusal that changes shape with how far the input travelled is a
    refusal that says where the doors are.

    `decodeSegment` is the adapter's, because decode-then-compare is the subtle
    half and two copies of it would drift. The RULE is stated here anyway, in
    full, rather than by calling `assertSafeKey`: that would have caught control
    characters too, and **measured, it masked them**: with the whole adapter
    check at this door, deleting the newline guard above reddened **0**, where
    on its own it reddens **2**. That guard was installed by a filed defect, so
    a version of this fix that made its removal invisible was not worth the
    lines it saved. A guard whose removal reddens nothing is not a guard.
  */
  if (clean.split("/").some((segment) => decodeSegment(segment) === ".")) return null;
  if (clean.split("/").some((segment) => decodeSegment(segment) === "..")) return null;
  return clean;
}

module.exports = { decodeSegment, normalizePath };
