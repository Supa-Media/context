import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  parsePluginSandboxMessage,
  pluginSandboxDocument,
  sandboxFrameIsOurs,
} from "@context/obsidian-runtime";
import type { ParsedSandboxEvent, PluginSandboxProps } from "./sandboxTypes";

/** One opaque-origin browser sandbox. Bundle bytes arrive after `ready`. */
export function PluginSandbox({ bundle, nonce, onEvent }: PluginSandboxProps) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  /*
    `srcdoc` is written once from the constant below and never re-set, so this
    counts documents rather than renders: the first load is ours and any later
    one is a frame that navigated itself somewhere. `sandboxFrameIsOurs` carries
    the reasoning and why no sandbox flag or CSP directive prevents it.
  */
  const loads = useRef(0);
  const disowned = useRef(false);
  const documentText = useMemo(() => pluginSandboxDocument(), []);
  const load = useCallback(() => {
    loads.current += 1;
    if (!sandboxFrameIsOurs(loads.current)) {
      // Before anything else: the successor gets no nonce and no bundle. The
      // flag is what stops the `rpc` door too, because `event.source` still
      // matches this element's `contentWindow` after a navigation.
      disowned.current = true;
      onEvent({ type: "disowned" });
      return;
    }
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
  }, [bundle.mainJs, bundle.manifestJson, nonce, onEvent]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (disowned.current) return;
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
