/**
 * What the app does with one thing the page runtime said, the same on web
 * (an iframe, `PageView.web.tsx`) and on a phone (a web view, `PageView.tsx`).
 * The transport differs; the checks do not: a link opens only as a web
 * address or a phone number, and anything that would change the note goes
 * through `pageChange` against the note as it is now.
 */

import { webUrl } from "../webUrl";
import { dialUrl, pageChange, type PageMessage } from "./pageHost";
import type { PageViewProps } from "./props";

export type PageNow = Pick<PageViewProps, "editable" | "author" | "onEdit" | "onOpenNote" | "onLoadImage">;

export type PageIo = {
  /** Answer the page. */
  post: (message: Record<string, unknown>) => void;
  /** Draw the note again as it is now. */
  render: () => void;
  /** The page is this tall (a frame sizes to it; a web view scrolls itself). */
  height: (height: number) => void;
  /** Open a checked web address or phone number outside the page. */
  open: (href: string, kind: "web" | "dial") => void;
  /** The page booted. */
  ready: () => void;
};

export function answerPage(message: PageMessage, now: PageNow, shown: string, io: PageIo): void {
  switch (message.type) {
    case "ready":
      io.ready();
      return;
    case "height":
      io.height(Math.max(120, message.height));
      return;
    case "open":
      if (webUrl(message.href) === message.href) io.open(message.href, "web");
      // A contact's Call and Text buttons: handed to the phone or the system, which never leaves the page.
      else if (dialUrl(message.href) === message.href) io.open(message.href, "dial");
      return;
    case "note":
      now.onOpenNote?.(message.target);
      return;
    case "image":
      void (now.onLoadImage?.(message.src) ?? Promise.resolve(null)).then(
        (data) => io.post({ type: "image", src: message.src, data }),
        () => io.post({ type: "image", src: message.src, data: null }),
      );
      return;
    default: {
      if (!now.editable || now.onEdit === undefined) return;
      const error = now.onEdit((current) => pageChange(current, shown, message, now.author) ?? { text: current });
      // Refused or stale: draw the note as it is now, so the reader sees what it holds.
      if (error !== null) io.render();
    }
  }
}
