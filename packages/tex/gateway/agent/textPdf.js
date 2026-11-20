/**
 * Words as a plain PDF: what printing an email to PDF gives a person, for a
 * page that asks for a file when what they have is an email (Dev, 2026-10-20:
 * a Church Center confirmation to attach as a receipt). Helvetica on letter
 * pages, wrapped, no dependency. A character the standard fonts cannot draw
 * is written as "?".
 */

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const SIZE = 10;
const LEADING = 13;
/** Characters on a line: Helvetica at 10 pt averages about 5 pt a character across 504 pt. */
const LINE_CHARS = 95;
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - 2 * MARGIN) / LEADING);
/** Enough for a long receipt; the rest is cut and says so. */
export const MAX_PAGES = 30;

/** One line of text as a PDF string's contents: Latin-1, escaped. */
function pdfString(line) {
  let out = "";
  for (const ch of line) {
    const code = ch.codePointAt(0);
    const byte = code === 0x2019 || code === 0x2018 ? 0x27 : code === 0x201c || code === 0x201d ? 0x22 : code === 0x2013 || code === 0x2014 ? 0x2d : code;
    out += byte >= 0x20 && byte <= 0xff && byte !== 0x7f ? String.fromCharCode(byte) : "?";
  }
  return out.replace(/[\\()]/g, (c) => `\\${c}`);
}

/** Lines no wider than LINE_CHARS, broken at spaces where there is one. */
export function wrap(text) {
  const lines = [];
  for (const raw of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    let rest = raw.replace(/\t/g, "    ").trimEnd();
    if (rest === "") lines.push("");
    while (rest.length > 0) {
      if (rest.length <= LINE_CHARS) {
        lines.push(rest);
        break;
      }
      const cut = rest.lastIndexOf(" ", LINE_CHARS);
      const at = cut > LINE_CHARS / 2 ? cut : LINE_CHARS;
      lines.push(rest.slice(0, at));
      rest = rest.slice(at).trimStart();
    }
  }
  return lines;
}

/**
 * @param {string} text
 * @returns {Uint8Array} a PDF
 */
export function textPdf(text) {
  let lines = wrap(text);
  const most = MAX_PAGES * LINES_PER_PAGE;
  if (lines.length > most) lines = [...lines.slice(0, most - 1), "[cut: the rest did not fit]"];
  const pages = [];
  for (let at = 0; at < Math.max(lines.length, 1); at += LINES_PER_PAGE) pages.push(lines.slice(at, at + LINES_PER_PAGE));

  // Objects: 1 catalog, 2 pages, 3 font, then a page and its contents for each page.
  const objects = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  pages.forEach((page, i) => {
    const stream =
      `BT /F1 ${SIZE} Tf ${LEADING} TL ${MARGIN} ${PAGE_HEIGHT - MARGIN - SIZE} Td\n` +
      page.map((line) => `(${pdfString(line)}) Tj T*`).join("\n") +
      "\nET";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i += 1) bytes[i] = out.charCodeAt(i);
  return bytes;
}
