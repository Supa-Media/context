import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import {
  WebView,
  type WebViewMessageEvent,
  type WebViewNavigation,
} from "react-native-webview";
import {
  parsePluginSandboxMessage,
  pluginSandboxDocument,
} from "@context/obsidian-runtime";
import type { ParsedSandboxEvent, PluginSandboxProps } from "./sandboxTypes";

/** The native half of the same sandbox, in its own WebView JavaScript realm. */
export function PluginSandbox({
  bundle,
  nonce,
  onEvent,
  activeFile = null,
  vaultEvent,
  invoke,
}: PluginSandboxProps) {
  const frame = useRef<WebView | null>(null);
  // See the web host: host-to-guest state only lands once the bundle is
  // running, and state rather than a ref so the note already open when a plugin
  // starts reaches it at that moment.
  const [loaded, setLoaded] = useState(false);
  const post = useCallback((payload: Record<string, unknown>) => {
    frame.current?.postMessage(
      JSON.stringify({ source: "context-plugin-host", version: 1, ...payload }),
    );
  }, []);
  const source = useMemo(
    () => ({ html: pluginSandboxDocument(), baseUrl: "about:blank" }),
    [],
  );
  const receive = useCallback(
    (event: WebViewMessageEvent) => {
      let value: unknown;
      try {
        value = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      const message = parsePluginSandboxMessage(
        value,
        nonce,
      ) as ParsedSandboxEvent | null;
      if (message === null) return;
      if (message.type === "ready") {
        frame.current?.postMessage(
          JSON.stringify({
            source: "context-plugin-host",
            version: 1,
            nonce,
            type: "load",
            mainJs: bundle.mainJs,
            manifestJson: bundle.manifestJson,
          }),
        );
        return;
      }
      if (message.type === "loaded") setLoaded(true);
      if (message.type === "unloaded" || message.type === "crashed") setLoaded(false);
      if (message.type === "rpc") {
        onEvent({
          ...message,
          respond: (response) =>
            frame.current?.postMessage(
              JSON.stringify({
                source: "context-plugin-host",
                version: 1,
                type: "rpc-result",
                response,
              }),
            ),
        });
      } else {
        onEvent(message);
      }
    },
    [bundle.mainJs, bundle.manifestJson, nonce, onEvent],
  );

  useEffect(() => {
    if (!loaded) return;
    post({
      type: "active-file",
      path: activeFile?.path ?? null,
      etag: activeFile?.etag ?? null,
    });
  }, [activeFile?.etag, activeFile?.path, loaded, post]);

  useEffect(() => {
    if (!loaded || vaultEvent === undefined) return;
    // Keyed on `seq` — see the web host for why the object itself will not do.
    post({
      type: "vault-event",
      kind: vaultEvent.kind,
      path: vaultEvent.path,
      from: vaultEvent.from,
      etag: vaultEvent.etag,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, post, vaultEvent?.seq]);

  useEffect(() => {
    if (!loaded || invoke === undefined) return;
    // Keyed on `seq` — see the web host. Two presses must be two messages, and
    // whether this frame is the one the press was aimed at is `invokeFor`'s.
    post({ type: "command", id: invoke.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, post, invoke?.seq]);

  return (
    <WebView
      ref={frame}
      source={source}
      style={styles.hidden}
      javaScriptEnabled
      domStorageEnabled={false}
      originWhitelist={["about:blank"]}
      setSupportMultipleWindows={false}
      onShouldStartLoadWithRequest={(request: WebViewNavigation) =>
        request.url === "about:blank"
      }
      onMessage={receive}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}

const styles = StyleSheet.create({
  hidden: { position: "absolute", width: 1, height: 1, opacity: 0 },
});
