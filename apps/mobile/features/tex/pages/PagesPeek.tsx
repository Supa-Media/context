import { useEffect, useState } from "react";
import { View } from "react-native";
import { ListBox, ListRow, More, SectionHead, T, useNow } from "../page/TexPageParts";
import { ago } from "../page/texPageFormat";
import type { TexPageSource } from "../page/texPageSource";
import type { TexMadePage } from "./pagesRead";

/** How many pages the Tex Hub shows before "All pages". */
export const PAGES_PEEK = 5;

/**
 * The Tex Hub's Pages section (owner, 2026-11-10: pages are "the default for
 * all work output done through Tex"): the pages this chat's turns and jobs
 * wrote, newest first, each opening as its page in the app. Draws nothing
 * while it reads, when it can't, or when there are none.
 */
export function PagesPeek({ source, chat, openNote }: { source: TexPageSource; chat: string; openNote?: (context: string, path: string) => void }) {
  const [pages, setPages] = useState<TexMadePage[] | null>(null);
  const [all, setAll] = useState(false);
  const now = useNow();
  useEffect(() => {
    let live = true;
    setPages(null);
    if (typeof source.pages !== "function") return;
    void source.pages(chat).then((read) => {
      if (live) setPages(read.kind === "ok" ? read.value : []);
    });
    return () => {
      live = false;
    };
  }, [source, chat]);
  if (pages === null || pages.length === 0) return null;
  const shown = all ? pages : pages.slice(0, PAGES_PEEK);
  return (
    <View testID="tex-pages-peek">
      <SectionHead>{`Pages · ${pages.length}`}</SectionHead>
      <ListBox>
        {shown.map((page) => (
          <ListRow
            key={`${page.context}/${page.path}`}
            title={page.title}
            sub={`@${page.context}/${page.path}`}
            right={
              <T size={13} tone="text2" numberOfLines={1}>
                {page.at > 0 ? `${ago(page.at, now)} ›` : "›"}
              </T>
            }
            onPress={openNote ? () => openNote(page.context, page.path) : undefined}
            testID={`tex-page-${page.path}`}
          />
        ))}
      </ListBox>
      {pages.length > PAGES_PEEK ? (
        <More onPress={() => setAll((open) => !open)} testID="tex-more-pages">
          {all ? "Fewer ›" : `All pages · ${pages.length} ›`}
        </More>
      ) : null}
    </View>
  );
}
