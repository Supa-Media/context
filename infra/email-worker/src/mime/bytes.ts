/**
 * Byte/string conversions and charset decoding for the MIME parser.
 *
 * Split out of `../mime.ts`; see that file's docblock for the parser's threat
 * model.
 */

const UTF8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

/**
 * Bytes → a string where one char is one byte.
 *
 * The whole parser works on this representation: MIME's structural syntax is
 * ASCII, so byte-per-char lets `indexOf` do the scanning at native speed while
 * keeping the payload lossless until a part's declared charset is known.
 * Chunked because `String.fromCharCode.apply` on a multi-megabyte array blows
 * the argument limit.
 */
export function latin1Decode(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  if (bytes.length <= CHUNK) {
    return String.fromCharCode(...(bytes as unknown as number[]));
  }
  let out = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    const slice = bytes.subarray(index, index + CHUNK);
    out += String.fromCharCode(...(slice as unknown as number[]));
  }
  return out;
}

/** The inverse: a byte-per-char string back to the bytes it stood for. */
export function latin1Encode(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    out[index] = value.charCodeAt(index) & 0xff;
  }
  return out;
}

/**
 * The 0x80–0x9F block, which is where windows-1252 and ISO-8859-1 disagree and
 * where every real-world mislabelled message lives. Below 0x80 and above 0x9F
 * the two agree with Unicode code points, so only this range needs a table.
 */
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6,
  0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018,
  0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161,
  0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

function cp1252Decode(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    out +=
      byte >= 0x80 && byte <= 0x9f
        ? String.fromCharCode(CP1252_HIGH[byte - 0x80]!)
        : String.fromCharCode(byte);
  }
  return out;
}

/**
 * Decode a part's bytes using its declared charset.
 *
 * UTF-8 and the Latin-1 family are decoded here rather than through
 * `TextDecoder`, because the Workers runtime's `TextDecoder` is documented as
 * UTF-8-only and constructing it with any other label throws. Anything outside
 * those families is attempted through the platform and falls back to UTF-8,
 * which is right far more often in 2026 than any single legacy guess.
 */
export function decodeBytes(bytes: Uint8Array, charset: string): string {
  const label = charset.toLowerCase().trim().replace(/^"|"$/g, "");
  if (!label || label === "utf-8" || label === "utf8" || label === "us-ascii" || label === "ascii") {
    return UTF8.decode(bytes);
  }
  if (
    label === "iso-8859-1" ||
    label === "iso8859-1" ||
    label === "latin1" ||
    label === "latin-1" ||
    label === "windows-1252" ||
    label === "cp1252"
  ) {
    return cp1252Decode(bytes);
  }
  try {
    return new TextDecoder(label, { fatal: false, ignoreBOM: false }).decode(bytes);
  } catch {
    return UTF8.decode(bytes);
  }
}
