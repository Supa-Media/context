import { getRandomBytes } from "expo-crypto";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, ScrollView, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Text } from "../../../design/components/Text";
import { useScheme } from "../../../design/theme";
import { useReachability } from "../../../offline/reachability";
import { consoleOrigin } from "../shareOrigin";
import { answerPage } from "./pageAnswer";
import { PAGE_CHANNEL, readPageMessage } from "./pageHost";
import { nativePageUrls, pageKeyScript, pageMessageFrom, pageScriptFor, pageLoadAllowed } from "./pageNative";
import type { PageViewProps } from "./props";

/** Whether this platform draws pages; the note screen shows the editor where it does not. */
export const PAGE_VIEW_AVAILABLE = true;

/**
 * A `.page.md` note drawn as a page on a phone: the same page runtime the web
 * console frames, in a web view (owner, 2026-11-10: pages "supposed to open up
 * seamlessly"; until now the phone showed a page as its Markdown).
 *
 * The runtime is loaded from the console's own origin
 * (`/drawing-assets/page/`), never the sites domain, whose other paths are a
 * customer's own website. A web view has no parent frame, so the page talks
 * to the app through the bridge, and it does so with a key this view puts in
 * the page's own frame before anything runs (`pageNative.ts`): a ```box
 * frame inside the page may reach the bridge on Android, but never the key.
 * Everything the page says then goes through `answerPage`, the same checks as
 * on web. The view navigates nowhere: links open outside it.
 */
export function PageView({ source, editable, author, onEdit, onOpenNote, onLoadImage, scrolls = false, topInset = 0 }: PageViewProps) {
  const scheme = useScheme();
  const view = useRef<WebView | null>(null);
  const [key] = useState(() => Array.from(getRandomBytes(24), (b) => b.toString(16).padStart(2, "0")).join(""));
  const urls = useMemo(() => nativePageUrls(consoleOrigin()), []);
  const [height, setHeight] = useState(480);
  const [failed, setFailed] = useState(false);
  // Tried again the moment the connection is back, rather than when somebody reopens the note.
  const reachability = useReachability();
  useEffect(() => {
    if (reachability === "online") setFailed(false);
  }, [reachability]);
  const ready = useRef(false);
  const shown = useRef<string | null>(null);
  const latest = useRef({ source, editable, author, onEdit, onOpenNote, onLoadImage, dark: scheme === "dark", topInset });
  latest.current = { source, editable, author, onEdit, onOpenNote, onLoadImage, dark: scheme === "dark", topInset };

  const post = useCallback((message: Record<string, unknown>) => {
    view.current?.injectJavaScript(pageScriptFor({ channel: PAGE_CHANNEL, ...message }));
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
      me: now.author,
      inset: Math.max(0, Math.round(now.topInset)),
    });
  }, [post]);

  useEffect(render, [render, source, editable, author, scheme, topInset]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = readPageMessage(pageMessageFrom(event.nativeEvent.data, key));
      if (message === null) return;
      answerPage(message, latest.current, shown.current ?? "", {
        post,
        render,
        height: setHeight,
        ready: () => {
          ready.current = true;
          render();
        },
        open: (href) => void Linking.openURL(href).catch(() => {}),
      });
    },
    [key, post, render],
  );

  if (urls === null || failed) {
    // Offline, or the runtime would not load: the page as the Markdown it is, which always reads.
    const words = <Text variant="body" selectable style={{ padding: 16 }}>{source}</Text>;
    return scrolls ? <ScrollView style={{ flex: 1 }}>{words}</ScrollView> : <View style={{ width: "100%" }}>{words}</View>;
  }
  const drawn = (
    <WebView
      ref={view}
      source={{ uri: urls.page }}
      injectedJavaScriptBeforeContentLoaded={pageKeyScript(key)}
      injectedJavaScriptBeforeContentLoadedForMainFrameOnly
      onMessage={onMessage}
      onLoadStart={() => {
        ready.current = false;
      }}
      onError={() => setFailed(true)}
      onHttpError={() => setFailed(true)}
      // One page and its sealed boxes; a link opens outside, through `answerPage`.
      onShouldStartLoadWithRequest={(request) => pageLoadAllowed(request.url, request.isTopFrame !== false, urls)}
      originWhitelist={[urls.origin]}
      javaScriptEnabled
      // A note is the customer's content: nothing of it outlives this view in a shared web store.
      incognito
      scrollEnabled={false}
      style={{ width: "100%", height, backgroundColor: "transparent" }}
    />
  );
  return scrolls ? <ScrollView style={{ flex: 1 }}>{drawn}</ScrollView> : <View style={{ width: "100%" }}>{drawn}</View>;
}
