/**
 * The homepage's pages with their cast blocks taken out, and the cast each
 * page plays, as values the shell and the tests can both hold.
 *
 * The router hands the homepage the site's Markdown as the owner wrote it,
 * cast blocks included (`websiteSnapshot`). A block is never text anybody
 * reads, so it comes out here, before the tree is built; what it scripted is
 * kept per page for `useHomeCast`.
 */

import { splitWebsiteCast, type CastChatSetup, type CastPaceName, type CastStep } from "@context/shared";
import type { PresenceMember } from "../../console/presence/protocol";
import type { Presence } from "../../console/presence/usePresence";
import type { SharedDoc } from "../../console/presence/sharedDoc";
import type { HomePage } from "../homeSite";
import { castColors } from "./castRun";

export interface CastSite {
  pages: readonly HomePage[];
  /** Route path → the steps that page plays. Pages with no cast are absent. */
  scripts: ReadonlyMap<string, readonly CastStep[]>;
  /** Every member's colour, across every page. */
  colors: ReadonlyMap<string, string>;
  /** Route path → the pace its scene asked for. Pages that asked for none are absent. */
  paces: ReadonlyMap<string, CastPaceName>;
  /** Route path → how its scene's chats are framed. Pages that said nothing are absent. */
  chats: ReadonlyMap<string, CastChatSetup>;
}

export function castSite(site: readonly HomePage[]): CastSite {
  const scripts = new Map<string, readonly CastStep[]>();
  const paces = new Map<string, CastPaceName>();
  const chats = new Map<string, CastChatSetup>();
  const pages = site.map((page) => {
    const split = splitWebsiteCast(page.markdown);
    if (split.steps.length > 0) scripts.set(page.routePath, split.steps);
    if (split.steps.length > 0 && split.pace !== undefined) paces.set(page.routePath, split.pace);
    if (split.steps.length > 0 && split.chat !== undefined) chats.set(page.routePath, split.chat);
    return split.markdown === page.markdown ? page : { ...page, markdown: split.markdown };
  });
  return { pages, scripts, colors: castColors([...scripts.values()].flat()), paces, chats };
}

const NOTHING = () => {};

/**
 * The cast's room as the console's `Presence`, so the editor binds it and the
 * chip draws it with no code of the homepage's own.
 *
 * Always live, always settled and always the writer: there is nobody else to
 * wait for or to elect, and the visitor's editor has to keep writing the text
 * into their copy of the page (`mayPersist`). `demo` is what makes the chip
 * say so.
 */
export function castPresence(
  shared: SharedDoc,
  members: PresenceMember[],
  commentFocus: Presence["commentFocus"] = null,
  peek: Presence["peek"] = null,
): Presence {
  return {
    commentFocus,
    peek,
    members,
    phase: "live",
    summary: members.length === 0 ? "" : members.length === 1 ? "1 here" : `${members.length} here`,
    report: NOTHING,
    shared,
    settled: true,
    canWrite: true,
    announceSaved: NOTHING,
    drawing: { share: NOTHING, point: NOTHING, compact: NOTHING },
    demo: true,
  };
}
