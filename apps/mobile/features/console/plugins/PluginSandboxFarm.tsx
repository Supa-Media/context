import { useCallback } from "react";
import { View } from "react-native";
import { PluginSandbox } from "./PluginSandbox";
import type { PluginGrant } from "./grants";
import type { ActiveFileRef, SandboxEvent, VaultEventMessage } from "./sandboxTypes";
import { maySeePaths } from "./runtime";
import type { ActiveSandbox } from "./runtime";

/** Trusted host for every active plugin; tokens remain in these closures. */
export function PluginSandboxFarm({
  sandboxes,
  onEvent,
  activeFile = null,
  vaultEvent,
  grants,
}: {
  sandboxes: ActiveSandbox[];
  onEvent: (sandbox: ActiveSandbox, event: SandboxEvent) => void;
  /** The open note — reaches only the plugins allowed to read notes at all. */
  activeFile?: ActiveFileRef | null;
  /** The last change Context made, under the same rule. */
  vaultEvent?: VaultEventMessage;
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
}: {
  sandbox: ActiveSandbox;
  onEvent: (sandbox: ActiveSandbox, event: SandboxEvent) => void;
  activeFile: ActiveFileRef | null;
  vaultEvent?: VaultEventMessage;
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
    />
  );
}
