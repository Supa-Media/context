/**
 * Which characters a font can actually draw.
 *
 * This exists because of what satori does when it cannot draw one: **nothing
 * visible fails.** The glyph renders as tofu — `□` — and the card ships, looking
 * broken, to every unfurler that ever caches it. There is no exception and no
 * error to catch.
 *
 * So the card is only rendered when every codepoint in the title is covered,
 * and otherwise the request falls back to the static product card. A generic
 * card is a worse card; a row of empty boxes with our branding around it is a
 * bug somebody screenshots.
 *
 * ## Why the coverage is read from the font rather than generated
 *
 * The obvious alternative is a build-time script emitting a list of ranges. It
 * is faster and it can drift: swap the TTF for a different subset and the list
 * still says what the old one covered, silently. Reading the font we actually
 * embed cannot disagree with itself. It costs one parse per isolate, memoised,
 * on a file that is already in the bundle.
 *
 * ## What this deliberately does not do
 *
 * It is not a shaping engine and makes no claim about *how* text will look —
 * only whether each character has a glyph at all. Combining marks, ligatures
 * and bidi are satori's business; the fuzzing that covers those lives in the
 * card's own tests.
 */

/**
 * The codepoints a TrueType/OpenType font has glyphs for.
 *
 * Reads the `cmap` table directly. Two subtable formats are handled because
 * two are what real fonts ship: format 4 (the BMP workhorse) and format 12
 * (full Unicode). A font offering neither returns an empty set, which fails
 * closed — every title would fall back to the static card rather than risk
 * tofu.
 */
export function fontCoverage(font: ArrayBuffer): Set<number> {
  const bytes = new Uint8Array(font);
  const view = new DataView(font);
  const covered = new Set<number>();

  const subtable = bestCmapSubtable(bytes, view);
  if (subtable === null) return covered;

  if (subtable.format === 4) readFormat4(view, subtable.offset, covered);
  else if (subtable.format === 12) readFormat12(view, subtable.offset, covered);

  return covered;
}

/**
 * The most useful cmap subtable in the font.
 *
 * Preferring (3,10) format 12 over (3,1) format 4 matters for a font that ships
 * both: format 4 cannot express anything above the BMP, so reading it alone
 * would report an emoji as uncovered on a font that can draw it. Ranking rather
 * than taking the first match is what makes the choice deterministic.
 */
function bestCmapSubtable(
  bytes: Uint8Array,
  view: DataView,
): { offset: number; format: number } | null {
  if (bytes.byteLength < 12) return null;

  const tableCount = view.getUint16(4);
  let cmapOffset: number | null = null;
  for (let i = 0; i < tableCount; i += 1) {
    const record = 12 + i * 16;
    if (record + 16 > bytes.byteLength) return null;
    const tag = String.fromCharCode(
      bytes[record],
      bytes[record + 1],
      bytes[record + 2],
      bytes[record + 3],
    );
    if (tag === "cmap") cmapOffset = view.getUint32(record + 8);
  }
  if (cmapOffset === null || cmapOffset + 4 > bytes.byteLength) return null;

  const subtableCount = view.getUint16(cmapOffset + 2);
  let best: { offset: number; format: number } | null = null;
  let bestScore = -1;

  for (let i = 0; i < subtableCount; i += 1) {
    const record = cmapOffset + 4 + i * 8;
    if (record + 8 > bytes.byteLength) break;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const offset = cmapOffset + view.getUint32(record + 4);
    if (offset + 2 > bytes.byteLength) continue;
    const format = view.getUint16(offset);

    let score = -1;
    if (platform === 3 && encoding === 10 && format === 12) score = 3;
    else if (platform === 3 && encoding === 1 && format === 4) score = 2;
    else if (format === 4 || format === 12) score = 1;

    if (score > bestScore) {
      bestScore = score;
      best = { offset, format };
    }
  }

  return bestScore < 0 ? null : best;
}

/** Format 4: segmented mapping, BMP only. */
function readFormat4(view: DataView, offset: number, out: Set<number>): void {
  const segCountX2 = view.getUint16(offset + 6);
  const segments = segCountX2 / 2;
  const endsAt = offset + 14;
  const startsAt = endsAt + segCountX2 + 2;
  const deltasAt = startsAt + segCountX2;
  const rangesAt = deltasAt + segCountX2;

  for (let segment = 0; segment < segments; segment += 1) {
    const end = view.getUint16(endsAt + segment * 2);
    const start = view.getUint16(startsAt + segment * 2);
    const delta = view.getInt16(deltasAt + segment * 2);
    const rangeOffset = view.getUint16(rangesAt + segment * 2);
    // The final segment is the required 0xFFFF terminator, not real coverage.
    if (start === 0xffff) continue;

    for (let code = start; code <= end && code !== 0x10000; code += 1) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (code + delta) & 0xffff;
      } else {
        const index = rangesAt + segment * 2 + rangeOffset + (code - start) * 2;
        if (index + 1 >= view.byteLength) continue;
        glyph = view.getUint16(index);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      // Glyph 0 is `.notdef` — the tofu box itself. Mapping to it is precisely
      // the state this whole module exists to detect, so it is not coverage.
      if (glyph !== 0) out.add(code);
    }
  }
}

/** Format 12: grouped ranges, full Unicode. */
function readFormat12(view: DataView, offset: number, out: Set<number>): void {
  const groups = view.getUint32(offset + 12);
  for (let group = 0; group < groups; group += 1) {
    const record = offset + 16 + group * 12;
    if (record + 12 > view.byteLength) break;
    const start = view.getUint32(record);
    const end = view.getUint32(record + 4);
    // A malformed group could otherwise spin for billions of iterations on a
    // worker with a CPU budget.
    if (end < start || end - start > 0x10ffff) continue;
    for (let code = start; code <= end; code += 1) out.add(code);
  }
}

/**
 * Can this text be drawn with these fonts, with no tofu?
 *
 * Iterates by codepoint (`for…of` on a string), not by UTF-16 unit, so an
 * astral character is one question rather than two halves that are both
 * uncovered.
 *
 * Whitespace is exempt. A space has no visible glyph to miss, and a font whose
 * cmap happens not to list `\n` must not send an ordinary English title to the
 * fallback.
 */
export function isRenderable(text: string, covered: Set<number>): boolean {
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    if (isWhitespace(code)) continue;
    if (!covered.has(code)) return false;
  }
  return true;
}

function isWhitespace(code: number): boolean {
  return (
    code === 0x20 || // space
    code === 0x09 || // tab
    code === 0x0a || // newline
    code === 0x0d || // carriage return
    code === 0xa0 // no-break space
  );
}
