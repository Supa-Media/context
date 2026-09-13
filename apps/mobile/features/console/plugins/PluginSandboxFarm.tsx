import { useCallback } from "react";
import { View } from "react-native";
import { PluginSandbox } from "./PluginSandbox";
import type { SandboxEvent } from "./sandboxTypes";
import type { ActiveSandbox } from "./runtime";

/** Trusted host for every active plugin; tokens remain in these closures. */
export function PluginSandboxFarm({
  sandboxes,
  onEvent,
}: {
  sandboxes: ActiveSandbox[];
  onEvent: (sandbox: ActiveSandbox, event: SandboxEvent) => void;
}) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {sandboxes.map((sandbox) => (
        <SandboxSlot
          key={`${sandbox.bundle.pluginId}:${sandbox.nonce}`}
          sandbox={sandbox}
          onEvent={onEvent}
        />
      ))}
    </View>
  );
}

function SandboxSlot({
  sandbox,
  onEvent,
}: {
  sandbox: ActiveSandbox;
  onEvent: (sandbox: ActiveSandbox, event: SandboxEvent) => void;
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
    />
  );
}
