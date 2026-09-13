/**
 * LZ-String, the half of it a Context bucket needs.
 *
 * ## Why this is vendored rather than depended on
 *
 * The Obsidian Excalidraw plugin stores a drawing's element JSON as
 * `compressToBase64` output under a ```compressed-json fence — that is the
 * plugin's default, so it is what a real customer's bucket actually contains.
 * Reading one therefore means implementing this algorithm, and the gateway
 * (`apps/mcp`) has **no npm dependencies at all** and runs on the Workers
 * runtime. A package is not available to it; a file is.
 *
 * Reproduced from pieroxy's `lz-string` (MIT), reduced to the base64 pair and
 * reformatted to this repository's style. The bit-twiddling is deliberately
 * left as the reference wrote it: this is a wire format, and a "tidier" loop
 * that shifts one bit differently produces a decoder that is silently wrong on
 * a subset of inputs rather than one that fails.
 *
 * ## What is honest about the test coverage, and what is not
 *
 * `compressToBase64` is here so the suite can round-trip. That proves the two
 * halves agree with **each other**; it does not by itself prove they agree with
 * the plugin, because a symmetric mistake in both would pass. Two things carry
 * that weight instead:
 *
 *  1. The suite asserts fixed base64 for fixed inputs, byte for byte, in both
 *     directions. Those strings were produced by this implementation and then
 *     pinned, so they do not prove agreement with the reference on their own —
 *     what they do catch is the change that quietly alters the format later,
 *     which is the failure that would actually reach a customer's bucket.
 *  2. Every caller treats a decode failure as "payload unavailable" rather than
 *     as an error — see `parseDrawing`. A drawing we cannot decompress still
 *     lists, still reads, still shows its text elements, and is never
 *     rewritten. The worst case of a bug in this file is a missing preview, not
 *     a corrupted file.
 */

const KEY_BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

/** char -> index, built once. */
const BASE64_VALUE = (() => {
  const map = new Map();
  for (let i = 0; i < KEY_BASE64.length; i++) map.set(KEY_BASE64.charAt(i), i);
  return map;
})();

/**
 * Compress a string to base64.
 *
 * Present for the round-trip half of the suite, and for anything that ever
 * needs to write a drawing back. Nothing in the read path calls it.
 */
export function compressToBase64(input) {
  if (input == null) return "";
  const compressed = compress(input, 6, (value) => KEY_BASE64.charAt(value));
  switch (compressed.length % 4) {
    case 0:
      return compressed;
    case 1:
      return `${compressed}===`;
    case 2:
      return `${compressed}==`;
    default:
      return `${compressed}=`;
  }
}

/**
 * Decompress base64 produced by `compressToBase64`, or `null` if it is not that.
 *
 * The plugin wraps its base64 across lines for readability, so whitespace is
 * stripped first: a line-wrapped payload is the common case, not the odd one.
 */
export function decompressFromBase64(input) {
  if (typeof input !== "string") return null;
  const packed = input.replace(/\s+/g, "");
  if (packed === "") return null;
  for (const character of packed) {
    if (!BASE64_VALUE.has(character)) return null;
  }
  try {
    return decompress(packed.length, 32, (index) => BASE64_VALUE.get(packed.charAt(index)) ?? 0);
  } catch {
    // A malformed payload can run the dictionary walk off its own end. That is
    // "this is not LZ-String", which is a null rather than a thrown error: see
    // the module header on why every caller needs a value back.
    return null;
  }
}

/* ------------------------- the reference algorithm ------------------------ */

function compress(uncompressed, bitsPerChar, getCharFromInt) {
  const dictionary = new Map();
  const toCreate = new Set();
  const data = [];
  let w = "";
  let enlargeIn = 2; // compensates for the first entry, which should not count
  let dictSize = 3;
  let numBits = 2;
  let dataVal = 0;
  let dataPosition = 0;

  const writeBits = (value, count) => {
    let remaining = value;
    for (let i = 0; i < count; i++) {
      dataVal = (dataVal << 1) | (remaining & 1);
      if (dataPosition === bitsPerChar - 1) {
        dataPosition = 0;
        data.push(getCharFromInt(dataVal));
        dataVal = 0;
      } else {
        dataPosition++;
      }
      remaining >>= 1;
    }
  };

  /** A token the dictionary has not emitted yet: a marker, then the literal. */
  const writeNewToken = (token) => {
    if (token.charCodeAt(0) < 256) {
      writeBits(0, numBits);
      writeBits(token.charCodeAt(0), 8);
    } else {
      // A 16-bit literal is announced by a single 1 bit followed by numBits-1
      // zeroes, which the reference writes as `value = 1` then `value = 0`.
      let flag = 1;
      for (let i = 0; i < numBits; i++) {
        dataVal = (dataVal << 1) | flag;
        if (dataPosition === bitsPerChar - 1) {
          dataPosition = 0;
          data.push(getCharFromInt(dataVal));
          dataVal = 0;
        } else {
          dataPosition++;
        }
        flag = 0;
      }
      writeBits(token.charCodeAt(0), 16);
    }
    enlargeIn--;
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
    toCreate.delete(token);
  };

  const emit = (token) => {
    if (toCreate.has(token)) writeNewToken(token);
    else writeBits(dictionary.get(token), numBits);
    enlargeIn--;
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
  };

  for (const c of codeUnits(uncompressed)) {
    if (!dictionary.has(c)) {
      dictionary.set(c, dictSize++);
      toCreate.add(c);
    }
    const wc = w + c;
    if (dictionary.has(wc)) {
      w = wc;
      continue;
    }
    emit(w);
    dictionary.set(wc, dictSize++);
    w = c;
  }

  if (w !== "") emit(w);

  writeBits(2, numBits); // end of stream
  for (;;) {
    dataVal <<= 1;
    if (dataPosition === bitsPerChar - 1) {
      data.push(getCharFromInt(dataVal));
      break;
    }
    dataPosition++;
  }
  return data.join("");
}

function decompress(length, resetValue, getNextValue) {
  const dictionary = [0, 1, 2];
  const result = [];
  let enlargeIn = 4;
  let dictSize = 4;
  let numBits = 3;
  const data = { val: getNextValue(0), position: resetValue, index: 1 };

  const readBits = (count) => {
    let bits = 0;
    let power = 1;
    const maxPower = 2 ** count;
    while (power !== maxPower) {
      const resb = data.val & data.position;
      data.position >>= 1;
      if (data.position === 0) {
        data.position = resetValue;
        data.val = getNextValue(data.index++);
      }
      bits |= (resb > 0 ? 1 : 0) * power;
      power <<= 1;
    }
    return bits;
  };

  let first;
  switch (readBits(2)) {
    case 0:
      first = String.fromCharCode(readBits(8));
      break;
    case 1:
      first = String.fromCharCode(readBits(16));
      break;
    default:
      return "";
  }
  dictionary[3] = first;
  let w = first;
  result.push(first);

  for (;;) {
    if (data.index > length) return "";
    let next = readBits(numBits);
    switch (next) {
      case 0:
        dictionary[dictSize++] = String.fromCharCode(readBits(8));
        next = dictSize - 1;
        enlargeIn--;
        break;
      case 1:
        dictionary[dictSize++] = String.fromCharCode(readBits(16));
        next = dictSize - 1;
        enlargeIn--;
        break;
      case 2:
        return result.join("");
      default:
        break;
    }

    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }

    let entry;
    if (typeof dictionary[next] === "string") entry = dictionary[next];
    else if (next === dictSize) entry = w + w.charAt(0);
    else return null;

    result.push(entry);
    dictionary[dictSize++] = w + entry.charAt(0);
    enlargeIn--;
    w = entry;

    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
  }
}

/**
 * Code units, not code points.
 *
 * LZ-String is defined over UTF-16 code units, and `for…of` over a string
 * iterates code *points* — which would take an emoji in a drawing's label as
 * one token where the reference takes two, and produce a payload the plugin
 * cannot read back.
 */
function codeUnits(value) {
  const out = [];
  for (let i = 0; i < value.length; i++) out.push(value.charAt(i));
  return out;
}
