import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  parsePluginSandboxMessage,
  pluginSandboxDocument,
} from "@context/obsidian-runtime";
import type { ParsedSandboxEvent, PluginSandboxProps } from "./sandboxTypes";

/** One opaque-origin browser sandbox. Bundle bytes arrive after `ready`. */
export function PluginSandbox({ bundle, nonce, onEvent }: PluginSandboxProps) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const documentText = useMemo(() => pluginSandboxDocument(), []);
  const load = useCallback(() => {
    frame.current?.contentWindow?.postMessage(
      {
        source: "context-plugin-host",
        version: 1,
        nonce,
        type: "load",
        mainJs: bundle.mainJs,
        manifestJson: bundle.manifestJson,
      },
      "*",
    );
  }, [bundle.mainJs, bundle.manifestJson, nonce]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = parsePluginSandboxMessage(
        event.data,
        nonce,
      ) as ParsedSandboxEvent | null;
      if (message === null) return;
      if (message.type === "ready") return;
      if (message.type === "rpc") {
        onEvent({
          ...message,
          respond: (response) =>
            frame.current?.contentWindow?.postMessage(
              {
                source: "context-plugin-host",
                version: 1,
                type: "rpc-result",
                response,
              },
              "*",
            ),
        });
      } else {
        onEvent(message);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [bundle.mainJs, bundle.manifestJson, nonce, onEvent]);

  return (
    <iframe
      ref={frame}
      sandbox="allow-scripts"
      srcDoc={documentText}
      onLoad={load}
      title={`Plugin sandbox: ${bundle.pluginId}`}
      aria-hidden="true"
      tabIndex={-1}
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        opacity: 0,
        border: 0,
        pointerEvents: "none",
      }}
    />
  );
}
