import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useScheme } from "../../../design/theme";
import { webUrl } from "../webUrl";
import type { PageViewProps } from "./props";
import { PAGE_CHANNEL, pageChange, pageFrameUrls, readPageMessage } from "./pageHost";

/** How long the sites-domain copy of the runtime has to say it is alive before the deployment's own copy is used. */
const READY_TIMEOUT_MS = 8_000;

/** Whether this platform draws pages; the note screen shows the editor where it does not. */
export const PAGE_VIEW_AVAILABLE = true;

/**
 * A `.page.md` note drawn as a page, in the sealed page runtime.
 *
 * An `<iframe sandbox="allow-scripts">`, never `allow-same-origin`, loaded from
 * `<handle>.ctxlc.site/_page/` in production and from this deployment's own
 * `/drawing-assets/page/` otherwise (`pageFrameUrls`). The note goes in as
 * text; what comes back is only ever a request, which `pageChange` checks
 * against the note as it is now before anything is written. See
 * `apps/mobile/page-frame/entry.js` for the frame's side and
 * `docs/decisions/app-and-console/pages.md` for the reasons.
 *
 * The frame is as tall as its page, so the note scrolls as one document.
 */
export function PageView({ source, editable, author, onEdit, onOpenNote, onLoadImage, scrolls = false }: PageViewProps) {
  const scheme = useScheme();
  // The workspace in the address (`/console/<slug>/…`), read from the location rather than the router so this stays a leaf.
  const rawSlug = typeof window === "undefined" ? undefined : /^\/console\/([^/]+)/.exec(window.location.pathname)?.[1];
  const slug = typeof rawSlug === "string" ? rawSlug.replace(/^@/, "").toLowerCase() : null;
  const [urls] = useState(() =>
    typeof window === "undefined" ? [] : pageFrameUrls({ hostname: window.location.hostname, origin: window.location.origin }, slug),
  );
  const [which, setWhich] = useState(0);
  const [height, setHeight] = useState(480);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const ready = useRef(false);
  const shown = useRef<string | null>(null);
  const latest = useRef({ source, editable, author, onEdit, onOpenNote, onLoadImage, dark: scheme === "dark" });
  latest.current = { source, editable, author, onEdit, onOpenNote, onLoadImage, dark: scheme === "dark" };

  const post = useCallback((message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ channel: PAGE_CHANNEL, ...message }, "*");
  }, []);

  const render = useCallback(() => {
    if (!ready.current) return;
    const now = latest.current;
    shown.current = now.source;
    post({
      type: "render",
      source: now.source,
      dark: now.dark,
      editable: now.editable && now.onEdit !== undefined,
      canComment: now.editable && now.onEdit !== undefined && now.author !== null,
    });
  }, [post]);

  useEffect(render, [render, source, editable, author, scheme]);

  useEffect(() => {
    ready.current = false;
    if (which >= urls.length - 1) return;
    const timer = setTimeout(() => {
      if (!ready.current) setWhich((n) => n + 1);
    }, READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [which, urls.length]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (frame.current === null || event.source !== frame.current.contentWindow) return;
      const message = readPageMessage(event.data);
      if (message === null) return;
      const now = latest.current;
      switch (message.type) {
        case "ready":
          ready.current = true;
          render();
          return;
        case "height":
          setHeight(Math.max(120, message.height));
          return;
        case "open":
          if (typeof window !== "undefined" && webUrl(message.href) === message.href) window.open(message.href, "_blank", "noopener,noreferrer");
          return;
        case "note":
          now.onOpenNote?.(message.target);
          return;
        case "image":
          void now.onLoadImage?.(message.src).then(
            (data) => post({ type: "image", src: message.src, data }),
            () => post({ type: "image", src: message.src, data: null }),
          );
          return;
        default: {
          if (!now.editable || now.onEdit === undefined) return;
          const seen = shown.current ?? "";
          const error = now.onEdit((current) => pageChange(current, seen, message, now.author) ?? { text: current });
          // Refused or stale: draw the note as it is now, so the reader sees what it holds.
          if (error !== null) render();
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post, render]);

  if (urls.length === 0) return null;
  const drawn = (
      <iframe
        key={urls[which]}
        ref={frame}
        src={urls[which]}
        title="Page"
        // Scripts, and nothing else: never same-origin, forms, popups or top navigation.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        style={{ width: "100%", height, border: 0, display: "block", background: "transparent" }}
      />
  );
  return scrolls ? <ScrollView style={{ flex: 1 }}>{drawn}</ScrollView> : <View style={{ width: "100%" }}>{drawn}</View>;
}
