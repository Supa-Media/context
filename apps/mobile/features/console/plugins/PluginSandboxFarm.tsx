import { useCallback } from "react";
import { View } from "react-native";
import { PluginSandbox } from "./PluginSandbox";
import type { PluginGrant } from "./grants";
import type {
  ActiveFileRef,
  InvokeMessage,
  PreviewMessage,
  SandboxEvent,
  VaultEventMessage,
} from "./sandboxTypes";
import { invokeFor, maySeeContent, maySeePaths, previewFor, suggestFor } from "./runtime";
import type { ActiveSandbox, InvokeRequest, PreviewRequest, SuggestRequest } from "./runtime";

/** Trusted host for every active plugin; tokens remain in these closures. */
export function PluginSandboxFarm({
  sandboxes,
  onEvent,
  activeFile = null,
  vaultEvent,
  invoke,
  suggest,
  suggestApply,
  modalQuery,
  modalPick,
  modalDismiss,
  textModalDismiss,
  settingsRequest,
  settingsChange,
  preview,
  grants,
}: {
  sandboxes: ActiveSandbox[];
  onEvent: (sandbox: ActiveSandbox, event: SandboxEvent) => void;
  /** The open note — reaches only the plugins allowed to read notes at all. */
  activeFile?: ActiveFileRef | null;
  /** The last change Context made, under the same rule. */
  vaultEvent?: VaultEventMessage;
  /** The command the owner pressed. Unlike the two above, it is not broadcast. */
  invoke?: InvokeRequest;
  /**
   * The line to suggest against, aimed at one frame.
   *
   * **Content, not a path**, so it passes a stricter gate than `activeFile`
   * does: `maySeeContent` requires `vault:read`, where `maySeePaths` also
   * accepts `metadata:read`. A plugin approved to read tags and links was not
   * approved to read the sentence somebody is typing.
   */
  suggest?: SuggestRequest;
  /** The pick, routed back to the frame that offered it. */
  suggestApply?: { seq: number; pluginId: string; nonce: string; index: number };
  /*
    The dialog's three, each addressed to one frame by plugin id *and* nonce.

    Not gated by `maySeeContent` like a suggestion or a preview, and the reason
    is what is being carried: a query is what the reader typed into a dialog
    this plugin put in front of them, not a line out of their note. A plugin
    with no read grant may still ask somebody a question.
  */
  modalQuery?: { seq: number; pluginId: string; nonce: string; query: string };
  modalPick?: { seq: number; pluginId: string; nonce: string; index: number };
  modalDismiss?: { seq: number; pluginId: string; nonce: string };
  textModalDismiss?: { seq: number; pluginId: string; nonce: string };
  settingsRequest?: { seq: number; pluginId: string; nonce: string; open: boolean };
  settingsChange?: {
    seq: number;
    pluginId: string;
    nonce: string;
    index: number;
    value: boolean | string | number;
  };
  /**
   * The open note's links, aimed at one frame, for its markdown post-processor.
   *
   * Under the same gate as `suggest` and for the same reason: a link is the
   * address somebody wrote down and the words they wrote around it, which is
   * note content rather than metadata about a note.
   */
  preview?: PreviewRequest;
  /** What each plugin was approved for. Absent means nobody is told anything. */
  grants?: readonly PluginGrant[];
}) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {sandboxes.map((sandbox) => {
        /*
          A path is note data, so it crosses only to a plugin the owner let read
          notes. Decided here rather than inside the sandbox: the guest is the
          untrusted half, and a filter it applied to itself would be no filter.
        */
        const shares = maySeePaths(sandbox.bundle, grants);
        return (
          <SandboxSlot
            key={`${sandbox.bundle.pluginId}:${sandbox.nonce}`}
            sandbox={sandbox}
            onEvent={onEvent}
            activeFile={shares ? activeFile : null}
            vaultEvent={shares ? vaultEvent : undefined}
            /*
              Routed, not broadcast, and not gated on `shares`: running a
              command the owner pressed is not a read, and the plugin it
              belongs to is the only one that hears about it.
            */
            invoke={invokeFor(sandbox, invoke)}
            /*
              Two gates, deliberately different. `shares` above decides who may
              be told a path; this decides who may be shown a line, and only
              `vault:read` opens it. Routed as well as gated — a query belongs
              to the frame it was aimed at, like a command.
            */
            suggest={maySeeContent(sandbox.bundle, grants) ? suggestFor(sandbox, suggest) : undefined}
            /* The third instruction, gated and routed exactly like the first. */
            preview={maySeeContent(sandbox.bundle, grants) ? previewFor(sandbox, preview) : undefined}
            suggestApply={
              suggestApply !== undefined &&
              suggestApply.pluginId === sandbox.bundle.pluginId &&
              suggestApply.nonce === sandbox.nonce
                ? { seq: suggestApply.seq, index: suggestApply.index }
                : undefined
            }
            modalQuery={
              modalQuery !== undefined &&
              modalQuery.pluginId === sandbox.bundle.pluginId &&
              modalQuery.nonce === sandbox.nonce
                ? { seq: modalQuery.seq, query: modalQuery.query }
                : undefined
            }
            modalPick={
              modalPick !== undefined &&
              modalPick.pluginId === sandbox.bundle.pluginId &&
              modalPick.nonce === sandbox.nonce
                ? { seq: modalPick.seq, index: modalPick.index }
                : undefined
            }
            settingsPane={
              settingsRequest !== undefined &&
              settingsRequest.pluginId === sandbox.bundle.pluginId &&
              settingsRequest.nonce === sandbox.nonce
                ? { seq: settingsRequest.seq, open: settingsRequest.open }
                : undefined
            }
            settingsChange={
              settingsChange !== undefined &&
              settingsChange.pluginId === sandbox.bundle.pluginId &&
              settingsChange.nonce === sandbox.nonce
                ? { seq: settingsChange.seq, index: settingsChange.index, value: settingsChange.value }
                : undefined
            }
            textModalDismiss={
              textModalDismiss !== undefined &&
              textModalDismiss.pluginId === sandbox.bundle.pluginId &&
              textModalDismiss.nonce === sandbox.nonce
                ? { seq: textModalDismiss.seq }
                : undefined
            }
            modalDismiss={
              modalDismiss !== undefined &&
              modalDismiss.pluginId === sandbox.bundle.pluginId &&
              modalDismiss.nonce === sandbox.nonce
                ? { seq: modalDismiss.seq }
                : undefined
            }
          />
        );
      })}
    </View>
  );
}

function SandboxSlot({
  sandbox,
  onEvent,
  activeFile,
  vaultEvent,
  invoke,
  suggest,
  suggestApply,
  modalQuery,
  modalPick,
  modalDismiss,
  textModalDismiss,
  settingsPane,
  settingsChange,
  preview,
}: {
  sandbox: ActiveSandbox;
  onEvent: (sandbox: ActiveSandbox, event: SandboxEvent) => void;
  activeFile: ActiveFileRef | null;
  vaultEvent?: VaultEventMessage;
  invoke?: InvokeMessage;
  suggest?: { seq: number; line: string; ch: number };
  suggestApply?: { seq: number; index: number };
  modalQuery?: { seq: number; query: string };
  modalPick?: { seq: number; index: number };
  modalDismiss?: { seq: number };
  textModalDismiss?: { seq: number };
  settingsPane?: { seq: number; open: boolean };
  settingsChange?: { seq: number; index: number; value: boolean | string | number };
  preview?: PreviewMessage;
}) {
  const receive = useCallback(
    (event: SandboxEvent) => onEvent(sandbox, event),
    [onEvent, sandbox],
  );
  return (
    <PluginSandbox
      bundle={sandbox.bundle}
      nonce={sandbox.nonce}
      onEvent={receive}
      activeFile={activeFile}
      vaultEvent={vaultEvent}
      invoke={invoke}
      suggest={suggest}
      suggestApply={suggestApply}
      modalQuery={modalQuery}
      modalPick={modalPick}
      modalDismiss={modalDismiss}
      textModalDismiss={textModalDismiss}
      settingsPane={settingsPane}
      settingsChange={settingsChange}
      preview={preview}
    />
  );
}
