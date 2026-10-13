import { useMemo } from "react";
import type { ConsoleNav } from "./ConsoleNavContext";
import { showTagOnHome } from "./home/homeTag";
import type { ConsoleRouter } from "./layout/types";
import { searchHref } from "./nav";
import { selectedContext, type ConsoleData } from "./types";

/**
 * The layout's nav, plus where a `#tag` pressed in a note goes: on a phone,
 * Home's tag filter (the note is closed so Home shows); wider, search for
 * `#tag` in the workspace the note is in. The demo homepage has nowhere to
 * show tags, so there a tag stays text.
 */
export function useNavWithTags(
  layoutNav: ConsoleNav,
  data: ConsoleData,
  phone: boolean,
  router: ConsoleRouter,
): ConsoleNav {
  const slug = selectedContext(data)?.slug ?? null;
  const { demo, files } = data;
  return useMemo(
    () => ({
      ...layoutNav,
      openTag: demo
        ? undefined
        : (tag: string) => {
            if (phone) {
              showTagOnHome(tag);
              files.deselect();
            } else {
              router.push(searchHref(`#${tag}`, slug === null ? [] : [slug]));
            }
          },
    }),
    [layoutNav, demo, files, phone, router, slug],
  );
}
