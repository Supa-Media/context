import type { ReactNode } from "react";
import type { useConsoleNav } from "../../ConsoleNavContext";
import type { FileBrowser } from "../../files/browser";
import { atName } from "../../format";
import { searchHref } from "../../nav";
import { NotFoundNote } from "./NotFoundNote";
import type { BrowsePaneProps } from "./props";

/**
 * `NotFoundNote`, wired to the console: the browser's listings and selection,
 * the search page for Search, and the console's own history for Go back
 * (a pointer layout only; a phone has its ‹). Kept out of `BrowseDocument`,
 * which only decides that this is the page to draw.
 */
export function NotFoundPage({
  path,
  files,
  slug,
  contextLabel,
  compact,
  nav,
  onNavigate,
  pathBar,
  notices,
}: {
  path: string;
  files: FileBrowser;
  slug: string | undefined;
  contextLabel: string;
  compact: boolean;
  nav: ReturnType<typeof useConsoleNav>;
  onNavigate?: BrowsePaneProps["onNavigate"];
  pathBar?: ReactNode;
  notices?: ReactNode;
}) {
  return (
    <NotFoundNote
      path={path}
      workspace={slug === undefined ? null : atName(slug)}
      rootLabel={contextLabel}
      listings={files.listings}
      ensureListing={files.ensureListing}
      compact={compact}
      // The root is Home, not a selection of "".
      onOpen={(to) => (to === "" ? files.deselect() : files.select(to))}
      onSearch={onNavigate === undefined ? undefined : (words) => onNavigate(searchHref(words, slug === undefined ? [] : [slug]))}
      onBack={!compact && nav?.canBack === true ? nav.back : undefined}
      pathBar={pathBar}
      notices={notices}
    />
  );
}
