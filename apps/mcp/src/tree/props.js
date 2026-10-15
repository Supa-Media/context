/**
 * The tree's properties: each note's front matter, inline `#tags`, first
 * heading, first paragraph and length, parsed by the same `noteProperties`,
 * `noteHeading` and `noteLede` every other reader uses, so a List read from
 * the bucket, a device's copy and the control plane's copy agree.
 *
 * ## Why it exists
 *
 * A project Board groups notes by `status:` and a List shows `owner:`; both
 * live inside each note. Read from the bucket, that was every note's text on
 * every open, which took minutes for a project folder (2026-10-08). The owner
 * chose to keep the front matter beside the tree ("lets go ahead and do
 * both", 2026-10-09) so a folder of any size answers in one query.
 *
 * The Convex control plane keeps these now (its tree's facts); the search
 * database's `tree_props` table that held them first was retired in phase 7
 * of `docs/decisions/app-and-console/convex-tree.md` (`tree/retired.js`).
 *
 * An encrypted note keeps no props: its front matter is inside the
 * ciphertext, and a List leaves it out as it always has.
 */

import { noteHeading, noteProperties } from "../lists/properties.js";
import { inlineTags } from "../lists/inlineTags.js";
import { noteLede } from "../lists/lede.js";
import { isEncryptedNote } from "../encryption/format.js";
import { countLines } from "../chaos/rubric.js";
import { siteFlagsOf } from "./siteFlags.js";

/**
 * What one note's text becomes: its properties, first heading and first
 * paragraph, or `null` for an encrypted note.
 *
 * @param {string} text
 * @returns {{ properties: Record<string, unknown>, inlineTags: string[], heading: string | null, lede: string | null, lines?: number, site?: { draft: boolean, restricts: boolean } } | null}
 */
export function propsOf(text) {
  if (typeof text !== "string") {
    return { properties: {}, inlineTags: [], heading: null, lede: null, lines: 0, site: { draft: false, restricts: false } };
  }
  if (isEncryptedNote(text)) return null;
  return {
    properties: { ...noteProperties(text) },
    // The `#tags` in its text, kept beside the front matter (`lists/inlineTags.js`).
    inlineTags: inlineTags(text),
    heading: noteHeading(text),
    lede: noteLede(text),
    // The chaos score's long-note rule (`chaos/rubric.js`).
    lines: countLines(text),
    // Whether a website may still publish it (`siteFlags.js`): a public list
    // asks the tree this rather than opening the page.
    site: siteFlagsOf(text),
  };
}
