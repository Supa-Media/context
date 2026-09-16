import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  parsePluginSandboxMessage,
  pluginSandboxDocument,
  sandboxFrameIsOurs,
} from "@context/obsidian-runtime";
import type { ParsedSandboxEvent, PluginSandboxProps } from "./sandboxTypes";

/** One opaque-origin browser sandbox. Bundle bytes arrive after `ready`. */
export function PluginSandbox({
  bundle,
  nonce,
  onEvent,
  activeFile = null,
  vaultEvent,
  invoke,
  suggest,
  suggestApply,
  modalQuery,
  modalPick,
  modalDismiss,
  preview,
}: PluginSandboxProps) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  /*
    Host-to-guest state is only deliverable once the bundle is running: the
    guest ignores anything but `load` before it has a nonce, and a plugin that
    has not run its `onload` has registered no handler to receive it. So both
    effects below wait for `loaded` — and because this is state rather than a
    ref, the active file that was already open when the plugin started is sent
    the moment it is, rather than only on the next change.
  */
  const [loaded, setLoaded] = useState(false);
  /*
    `srcdoc` is written once from the constant below and never re-set, so this
    counts documents rather than renders: the first load is ours and any later
    one is a frame that navigated itself somewhere. `sandboxFrameIsOurs` carries
    the reasoning and why no sandbox flag or CSP directive prevents it.
  */
  const loads = useRef(0);
  const disowned = useRef(false);
  const post = useCallback((payload: Record<string, unknown>) => {
    if (disowned.current) return;
    frame.current?.contentWindow?.postMessage(
      { source: "context-plugin-host", version: 1, ...payload },
      "*",
    );
  }, []);
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
      if (message.type === "loaded") setLoaded(true);
      if (message.type === "unloaded" || message.type === "crashed") setLoaded(false);
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
    /*
      Keyed on `seq` alone. The object arrives new on every render, so an effect
      that depended on it would replay the same change repeatedly — and a plugin
      counting tasks would count one edit several times.
    */
    post({
      type: "vault-event",
      kind: vaultEvent.kind,
      path: vaultEvent.path,
      from: vaultEvent.from,
      etag: vaultEvent.etag,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, post, vaultEvent?.seq]);

  /*
    Run a command the owner pressed.

    Keyed on `seq` for the same reason as `vault-event`, and here the reason is
    not an optimisation: pressing the same command twice must send it twice, and
    an effect depending on the object would fire on every unrelated render
    instead.

    This posts whatever it is handed. Whether the press was aimed at *this*
    frame is not knowable here — a restart mounts a new sandbox that also goes
    from not-loaded to loaded — so the address is checked in `invokeFor`, where
    the frames are known. Do not add a guard here that pretends otherwise.
  */
  /*
    Ask this plugin whether it wants to suggest against the line somebody is
    typing. Keyed on `seq` like every other slot here: the object arrives new on
    every render, and a query sent twice would answer twice for one keystroke.

    Whether this frame should be asked at all is decided in the farm — the line
    is note content and `maySeeContent` is the gate. This posts what it is given.
  */
  useEffect(() => {
    if (!loaded || suggest === undefined) return;
    post({ type: "suggest-query", seq: suggest.seq, line: suggest.line, ch: suggest.ch });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, post, suggest?.seq]);

  useEffect(() => {
    if (!loaded || suggestApply === undefined) return;
    post({ type: "suggest-apply", seq: suggestApply.seq, index: suggestApply.index });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, post, suggestApply?.seq]);

  /*
    And the note's links, for whatever markdown post-processor the plugin
    registered. Keyed on `seq` for the same reason, gated in the farm for the
    same reason, and posted here without interpretation for the same reason.
  */
  /*
    The dialog's half of the round trip, keyed on `seq` like every other slot
    here and for the same reason: the object arrives new on every render, and a
    query sent twice would answer twice for one keystroke.

    Gated in the farm, not here — a query carries what the reader typed into the
    dialog, which is theirs, and the plugin that opened it is the only one asked.
  */
  useEffect(() => {
    if (!loaded || modalQuery === undefined) return;
    post({ type: "suggest-modal-query", seq: modalQuery.seq, query: modalQuery.query });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, post, modalQuery?.seq]);

  useEffect(() => {
    if (!loaded || modalPick === undefined) return;
    post({ type: "suggest-modal-pick", seq: modalPick.seq, index: modalPick.index });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, post, modalPick?.seq]);

  useEffect(() => {
    if (!loaded || modalDismiss === undefined) return;
    post({ type: "suggest-modal-dismiss", seq: modalDismiss.seq });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, post, modalDismiss?.seq]);

  useEffect(() => {
    if (!loaded || preview === undefined) return;
    post({ type: "preview-query", seq: preview.seq, links: preview.links });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, post, preview?.seq]);

  useEffect(() => {
    if (!loaded || invoke === undefined) return;
    post({ type: "command", id: invoke.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, post, invoke?.seq]);

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
