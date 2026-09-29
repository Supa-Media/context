import { useEffect, useMemo, useRef, useState } from "react";
import { splitWebsiteCast } from "@context/shared";
import { stripFrontmatter } from "../share/markdown";
import { MAX_PREVIEW_PAGES, previewSlug, type PreviewPage } from "../home/castPreview";

/** Reads the page a scene's `opens:` names, or `null` when there is none. */
export type ReadScenePage = (name: string) => Promise<PreviewPage | null>;

/** The pages a scene opens, as its script names them, each once. */
export function sceneOpens(draft: string): string[] {
  const names = new Map<string, string>();
  for (const step of splitWebsiteCast(stripFrontmatter(draft)).steps) {
    if (step.kind !== "open") continue;
    const slug = previewSlug(step.page);
    if (slug !== "" && !names.has(slug)) names.set(slug, step.page);
  }
  return [...names.values()].slice(0, MAX_PREVIEW_PAGES);
}

/** A carried page by every name the script might have used for it. */
export function pagesByName(pages: readonly PreviewPage[]): Record<string, string> {
  const byName: Record<string, string> = {};
  for (const page of pages) byName[page.name] = byName[page.name.toLowerCase()] = page.markdown;
  return byName;
}

/**
 * The pages the draft's scene opens, read once for each set of names, so the
 * studio's stage has them to go to and its script is timed against them.
 */
export function useScenePages(draft: string, read: ReadScenePage | undefined): readonly PreviewPage[] {
  const names = useMemo(() => sceneOpens(draft), [draft]);
  const key = names.join("\n");
  const reader = useRef(read);
  reader.current = read;
  const [pages, setPages] = useState<readonly PreviewPage[]>([]);
  useEffect(() => {
    const load = reader.current;
    if (load === undefined || names.length === 0) {
      setPages((current) => (current.length === 0 ? current : []));
      return;
    }
    let live = true;
    void Promise.all(names.map((name) => load(name).catch(() => null))).then((found) => {
      if (live) setPages(found.filter((page): page is PreviewPage => page !== null));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the names, not the array holding them
  }, [key]);
  return pages;
}
