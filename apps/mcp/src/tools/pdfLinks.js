export { MAX_LINKS, MAX_INFLATED_BYTES, pdfLinks } from "../../../../packages/shared/src/texContract/pdfLinks.cjs";

/** The lines `read_file` adds under a PDF's words, or nothing when it links nowhere. */
export function linksSection(links) {
  if (links.length === 0) return "";
  return `\n\nLinks in this file (where its buttons and linked words go):\n${links.map((link) => `- ${link}`).join("\n")}`;
}
