/** Types for `contextGateway.cjs`; see that file. */

export interface ContextGatewayParts {
  callTool: (params: unknown, store: unknown, session: unknown, options?: unknown) => Promise<any>;
  callTexAction: (params: unknown, store: unknown, session: unknown) => Promise<any>;
  recordRead: (ledger: unknown, call: { name: string; args?: unknown; result: unknown; writing?: boolean }) => void;
  controlPlane: (env: unknown) => any;
  isPlumbing: (key: string) => boolean;
  readsAsChat: (names: unknown) => boolean;
  teamCanSee: (store: unknown, path: string) => Promise<boolean>;
  judgeWords: (input: unknown, config: unknown, options?: { model?: string; effort?: string; fetchImpl?: unknown }) => Promise<{ allow: boolean; reason: string }>;
}

export declare const CONTEXT_GATEWAY_PARTS: readonly (keyof ContextGatewayParts)[];
export declare function connectContextGateway(parts: ContextGatewayParts): void;
export declare function contextGateway(): ContextGatewayParts;
