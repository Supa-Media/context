/**
 * The `attributedBody` heuristic, pinned against hand-built fixture blobs.
 *
 * There is no real macOS `chat.db` in this sandbox to extract a genuine blob
 * from, so every fixture here is built by this file's own `fixture()` helper
 * — which does not import the module under test, so a bug shared between the
 * two would not cancel out. What is real is the *shape*: both archiver
 * formats this app might meet spell the class name `NSString` in plain ASCII
 * immediately before a length-prefixed run of the string's own UTF-8 bytes,
 * and that is the one fact `extractAttributedBodyText` depends on.
 *
 * ## Sabotage record
 *
 * Measured by actually editing `src/core/imessage/attributedBody.ts` and
 * reverting:
 *
 *   `lastIndexOfBytes` searching forward instead of backward           1 FAIL
 *
 * The low count is the finding, not a shortcoming of the check: an earlier,
 * stricter attempt at rejecting control-byte candidates (stop scanning at the
 * first in-bounds length, whether or not its content passed) was tried here
 * and *broke real decoding* — measured against the actual hex fixture in
 * `imessageSqlite.test.mjs`, where the true length byte sits a few bytes past
 * one that looks like a valid-but-wrong length on its own. The comment on
 * `tryReadAt` in the source carries that finding; the fixed algorithm favours
 * "keep scanning past a rejection" for the reason argued there.
 */

import { attributedBodyFromHex, extractAttributedBodyText } from "../src/core/imessage/attributedBody.ts";

const encoder = new TextEncoder();

function concat(...arrays) {
  const total = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
  let offset = 0;
  for (const array of arrays) {
    total.set(array, offset);
    offset += array.length;
  }
  return total;
}

/**
 * A blob shaped like the streamtyped/bplist family this app targets: some
 * archiver noise, the literal bytes "NSString", `padding` more bytes of
 * archiver metadata, a one-byte length, then the string's own UTF-8 bytes.
 */
function fixture(text, { padding = 3, prefix = "some archiver header " } = {}) {
  const body = encoder.encode(text);
  return concat(
    encoder.encode(prefix),
    encoder.encode("NSString"),
    new Uint8Array(padding),
    new Uint8Array([body.length]),
    body,
  );
}

/** The `0x81 <uint16-LE length>` long-string form. */
function longFormFixture(text) {
  const body = encoder.encode(text);
  const length = new Uint8Array([0x81, body.length & 0xff, (body.length >> 8) & 0xff]);
  return concat(encoder.encode("junk NSString "), length, body);
}

export function runImessageAttributedBodyChecks(check) {
  check("a plain ASCII string is recovered", extractAttributedBodyText(fixture("Hello there")) === "Hello there");
  check(
    "a UTF-8 string with real content is recovered byte-correctly",
    extractAttributedBodyText(fixture("café ☕ déjà vu")) === "café ☕ déjà vu",
  );
  check(
    "the scan is a bounded window, not one fixed offset — extra padding is still found",
    extractAttributedBodyText(fixture("still findable", { padding: 8 })) === "still findable",
  );
  check(
    "the long-string form (0x81 + uint16 length) is also recovered",
    extractAttributedBodyText(longFormFixture("a longer message body")) === "a longer message body",
  );
  check(
    "the LAST 'NSString' in the blob is used, not the first",
    extractAttributedBodyText(concat(fixture("wrong one, this is the class table"), fixture("the real payload"))) ===
      "the real payload",
  );

  check("no marker at all answers null", extractAttributedBodyText(encoder.encode("nothing to see here")) === null);
  check("an empty blob answers null", extractAttributedBodyText(new Uint8Array(0)) === null);
  check(
    "a marker with no plausible length byte within the window answers null",
    extractAttributedBodyText(concat(encoder.encode("NSString"), new Uint8Array(40).fill(0xff))) === null,
  );
  check(
    "a would-be candidate containing control bytes is rejected rather than accepted verbatim",
    extractAttributedBodyText(concat(encoder.encode("NSString"), new Uint8Array([0x03]), encoder.encode("a\x00b"))) === null,
  );

  const surrounding = fixture("wrapped");
  check(
    "leading and trailing whitespace in the recovered string is trimmed",
    extractAttributedBodyText(fixture("  padded with spaces  ")) === "padded with spaces",
  );
  check("a string that is only whitespace answers null rather than an empty string", extractAttributedBodyText(fixture("   ")) === null);

  // -- attributedBodyFromHex: the actual entry point sqlite.ts's rows use ----
  const hex = Buffer.from(fixture("via hex")).toString("hex");
  check("attributedBodyFromHex decodes the hex column sqlite3's query produces", attributedBodyFromHex(hex) === "via hex");
  check("attributedBodyFromHex refuses null (what a NULL blob's hex() comes back as)", attributedBodyFromHex(null) === null);
  check("attributedBodyFromHex refuses an empty string", attributedBodyFromHex("") === null);
  check("attributedBodyFromHex refuses an odd-length string", attributedBodyFromHex("abc") === null);
  check("attributedBodyFromHex refuses non-hex characters", attributedBodyFromHex("zz00") === null);
  check("attributedBodyFromHex is case-insensitive, as sqlite3's hex() output always is uppercase", attributedBodyFromHex(hex.toUpperCase()) === "via hex");
}
