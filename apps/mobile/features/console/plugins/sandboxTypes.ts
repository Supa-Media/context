export interface PluginRuntimeBundle {
  pluginId: string;
  version: string;
  bundleFingerprint: string;
  manifestJson: string;
  mainJs: string;
  stylesCss: string | null;
  runtimeToken: string;
  expiresAt: number;
}

export type SandboxEvent =
  | { type: "loaded" | "unloaded" }
  | { type: "rpc"; request: object; respond: (response: unknown) => void }
  | { type: "crashed"; code: string; message: string }
  | { type: "notice"; message: string }
  | {
      type: "registration";
      kind: "command" | "ribbon";
      id: string;
      name: string;
    };

export type ParsedSandboxEvent =
  | { type: "ready" }
  | Exclude<SandboxEvent, { type: "rpc" }>
  | { type: "rpc"; request: object };

export interface PluginSandboxProps {
  bundle: PluginRuntimeBundle;
  nonce: string;
  onEvent: (event: SandboxEvent) => void;
}
