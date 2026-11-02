import type { PageViewProps } from "./props";

/**
 * Native has no Page view yet: a `.page.md` note opens in the editor as the
 * Markdown it is, which is always readable. Links Tex texts open in the
 * browser, where `PageView.web.tsx` draws it.
 */
export function PageView(_props: PageViewProps): null {
  return null;
}

/** Whether this platform draws pages; the note screen shows the editor where it does not. */
export const PAGE_VIEW_AVAILABLE = false;
