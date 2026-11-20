/** What one MCP tool result shows the model: its words, bounded, and its pictures (moved out of `turn.js`). */

/**
 * The biggest tool answer that goes back to the model.
 *
 * A long note is a legitimate answer, so this is generous — but it is a bound,
 * because without one a single `read_note` on a large file decides how many
 * tokens a turn is billed for, and the model gets a worse prompt out of
 * it than a truncated one with a line saying so.
 */
export const MAX_TOOL_RESULT_CHARS = 60_000;

/** Flatten an MCP tool result into the text the model reads back. */
export function toolResultText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[truncated: the full result was ${text.length} characters]`;
}

/** The most pictures one tool result shows the model, and how big each may be (Anthropic's own ceiling). */
const MAX_RESULT_IMAGES = 2;
const MAX_RESULT_IMAGE_CHARS = Math.ceil((5_000_000 * 4) / 3);
const RESULT_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** A PDF a tool hands back whole (`read_file` on a PDF of pictures), at most: the size `read_file` reads a file at. */
const MAX_RESULT_PDF_CHARS = Math.ceil((10 * 1024 * 1024 * 4) / 3);
const PDF = "application/pdf";

/**
 * The pictures an MCP tool result carries (`read_image`, a drawn picture), so
 * the model sees what it asked to look at rather than only the words beside it,
 * and one PDF handed back whole as an embedded resource, so a PDF of pictures
 * is read page by page (`readFile.js` A PDF OF PICTURES; `providers.js` makes
 * it a document block).
 */
export function toolResultImages(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const pictures = content
    .filter((part) => part?.type === "image" && typeof part.data === "string" && RESULT_IMAGE_TYPES.has(part.mimeType) && part.data.length <= MAX_RESULT_IMAGE_CHARS)
    .slice(0, MAX_RESULT_IMAGES)
    .map((part) => ({ mediaType: part.mimeType, data: part.data }));
  const pdf = content.find(
    (part) => part?.type === "resource" && part.resource?.mimeType === PDF && typeof part.resource.blob === "string" && part.resource.blob.length <= MAX_RESULT_PDF_CHARS,
  );
  return pdf ? [...pictures, { mediaType: PDF, data: pdf.resource.blob }] : pictures;
}
