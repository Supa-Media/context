/**
 * Fixture constants shared between the two `read_image` subject files
 * (attachmentsCore.test.mjs and attachmentsEdge.test.mjs). Both need the same
 * hash-named image leaves and the same all-refusals-look-alike helper, so
 * they are defined once here rather than duplicated.
 */
export const PNG_BYTES = new Uint8Array([
  // A real PNG header, then bytes that are deliberately not valid UTF-8. If the
  // pipeline mangles them the base64 comparison below fails loudly, which is
  // exactly what the old string-backed stub could not do.
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0xc0, 0x80, 0x01,
]);
export const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");
export const TEAM_IMAGE = `${"a".repeat(64)}.png`;
export const PRIVATE_IMAGE = `${"b".repeat(64)}.png`;
export const ORPHAN_IMAGE = `${"c".repeat(64)}.png`;
export const SHARED_IMAGE = `${"d".repeat(64)}.png`;
export const SCRIPT_OBJECT = `${"e".repeat(64)}.sh`;

export const REFUSAL = "not found";
export const refusalText = (result) => (result.isError ? result.content?.[0]?.text : `RESOLVED:${JSON.stringify(result)}`);
