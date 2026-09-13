import { useCallback, useMemo, useRef } from "react";
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
export function PluginSandbox({ bundle, nonce, onEvent }: PluginSandboxProps) {
  const frame = useRef<WebView | null>(null);
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
