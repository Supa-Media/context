/**
 * The words in a Word, PowerPoint or Excel file, so a texted document reaches
 * the model as text (`attachments.ts`).
 *
 * These files are zip archives of XML. This reads the archive's central
 * directory, inflates only the parts that hold words (with the runtime's own
 * `DecompressionStream`, no library), and strips the markup. Layout, pictures
 * and formulas are lost; the words, in order, are kept, which is what a
 * question about the file needs.
 *
 * Bounded on purpose: a zip can claim anything about itself, so every part is
 * inflated under a byte ceiling and the whole under a character ceiling, and
 * anything malformed is a `null`, never a throw.
 */

export type OfficeKind = "docx" | "pptx" | "xlsx";

/** Most bytes one inflated part may grow to: a zip bomb stops here. */
const MAX_PART_BYTES = 8 * 1024 * 1024;
/** Most parts read from one file (slides, sheets). */
const MAX_PARTS = 200;
/** Most characters returned. */
export const MAX_OFFICE_CHARS = 100_000;

type Entry = { name: string; method: number; compressedSize: number; offset: number };

function entries(bytes: Uint8Array): Map<string, Entry> | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: 22 bytes plus a comment of up to 64 KB, at the end.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = new Map<string, Entry>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return null;
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    out.set(name, { name, method, compressedSize, offset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

async function inflate(bytes: Uint8Array, entry: Entry): Promise<string | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const local = entry.offset;
  if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) return null;
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const body = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return body.length <= MAX_PART_BYTES ? new TextDecoder().decode(body) : null;
  if (entry.method !== 8) return null;
  const reader = new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_PART_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(joined);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Paragraph ends become new lines, tabs and breaks stay, every other tag goes. */
function paragraphs(xml: string, paragraph: string): string {
  return unescapeXml(
    xml
      .replace(new RegExp(`</${paragraph}>`, "g"), "\n")
      .replace(/<(w|a):tab\/>/g, "\t")
      .replace(/<(w|a):br\/>/g, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const numbered = (prefix: string) => (a: string, b: string) =>
  Number(a.slice(prefix.length).replace(/\D/g, "")) - Number(b.slice(prefix.length).replace(/\D/g, ""));

function sheetText(xml: string, shared: string[]): string {
  const rows: string[] = [];
  for (const row of xml.match(/<row[\s>][\s\S]*?<\/row>/g) ?? []) {
    const cells: string[] = [];
    for (const cell of row.match(/<c[\s>][\s\S]*?(<\/c>|\/>)/g) ?? []) {
      const type = /\bt="([^"]+)"/.exec(cell)?.[1];
      const value = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1];
      if (type === "s" && value !== undefined) cells.push(shared[Number(value)] ?? "");
      else if (type === "inlineStr") cells.push(unescapeXml((/<t[^>]*>([\s\S]*?)<\/t>/.exec(cell)?.[1] ?? "")));
      else cells.push(value === undefined ? "" : unescapeXml(value));
    }
    if (cells.some((cell) => cell !== "")) rows.push(cells.join("\t"));
  }
  return rows.join("\n");
}

/** The file's words, or null when it is not a readable file of that kind. */
export async function officeText(bytes: Uint8Array, kind: OfficeKind): Promise<string | null> {
  let parts: Map<string, Entry> | null;
  try {
    parts = entries(bytes);
  } catch {
    return null;
  }
  if (!parts) return null;
  const read = async (name: string) => {
    const entry = parts.get(name);
    return entry ? await inflate(bytes, entry) : null;
  };
  let text: string | null = null;
  if (kind === "docx") {
    const xml = await read("word/document.xml");
    text = xml === null ? null : paragraphs(xml, "w:p");
  } else if (kind === "pptx") {
    const slides = [...parts.keys()]
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort(numbered("ppt/slides/slide"))
      .slice(0, MAX_PARTS);
    const out: string[] = [];
    for (const [index, name] of slides.entries()) {
      const xml = await read(name);
      if (xml !== null) out.push(`Slide ${index + 1}:\n${paragraphs(xml, "a:p")}`);
    }
    text = slides.length === 0 ? null : out.join("\n\n");
  } else {
    const sharedXml = await read("xl/sharedStrings.xml");
    const shared = (sharedXml?.match(/<si>[\s\S]*?<\/si>/g) ?? []).map((item) => unescapeXml(item.replace(/<[^>]*>/g, "")));
    const sheets = [...parts.keys()]
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
      .sort(numbered("xl/worksheets/sheet"))
      .slice(0, MAX_PARTS);
    const out: string[] = [];
    for (const [index, name] of sheets.entries()) {
      const xml = await read(name);
      if (xml !== null) out.push(`Sheet ${index + 1}:\n${sheetText(xml, shared)}`);
    }
    text = sheets.length === 0 ? null : out.join("\n\n");
  }
  return text === null ? null : text.slice(0, MAX_OFFICE_CHARS);
}
