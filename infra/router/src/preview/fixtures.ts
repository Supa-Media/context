// Shared fixtures for the preview suite, split out of `preview.test.ts` so
// each behavioural slice can stay under the file-size ceiling. Named
// `fixtures.ts` rather than `*.test.ts` so vitest does not treat it as a
// suite of its own.
//
// The same import `../index.ts` serves the card from, resolved the same
// way: `wrangler.jsonc`'s `Data` rule in production, `vitest.config.ts`'s
// matching plugin here. Reading the file with node:fs instead would test a
// different artefact — and would need @types/node, which this Worker has no
// other use for.
import ogCard from "../og-card.png";
import {
  GENERIC_PREVIEW,
  OG_CARD_PATH,
  escapeHtml,
  isCrawler,
  previewFor,
  previewForShare,
  previewFromProfile,
  renderPreviewHtml,
  shareTokenFrom,
  consoleNoteFrom,
  previewForNote,
  shortLinkFrom,
  previewForShortLink,
  shortLinkCardFrom,
  shortLinkCardPath,
} from "../preview";
import { route } from "../route";
import shareSegmentCases from "../shareSegment.fixtures.json";
import shortLinkSlugCases from "../shortLinkSlug.fixtures.json";

export {
  ogCard,
  GENERIC_PREVIEW,
  OG_CARD_PATH,
  escapeHtml,
  isCrawler,
  previewFor,
  previewForShare,
  previewFromProfile,
  renderPreviewHtml,
  shareTokenFrom,
  consoleNoteFrom,
  previewForNote,
  shortLinkFrom,
  previewForShortLink,
  shortLinkCardFrom,
  shortLinkCardPath,
  route,
  shareSegmentCases,
  shortLinkSlugCases,
};

/** Render whatever a crawler asking for `pathname` would be sent. */
export function previewHtml(pathname: string): string {
  return renderPreviewHtml(previewFor(pathname));
}

/** Pull the `content` of a `<meta>` identified by an attribute. */
export function meta(html: string, attr: "property" | "name", key: string): string[] {
  const pattern = new RegExp(
    `<meta ${attr}="${key}" content="([^"]*)">`,
    "g",
  );
  return [...html.matchAll(pattern)].map((m) => m[1]!);
}
