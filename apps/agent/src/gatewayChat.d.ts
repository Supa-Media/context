// The gateway's door into this Worker's chat code (`gatewayChat.js`), declared loosely: the types that matter are
// checked by this Worker's own config, on the files it re-exports.
export const SenderInbox: new (state: unknown, env: unknown) => { fetch(request: Request): Promise<Response>; alarm(): Promise<void> };
export function arrive(stubs: (name: string) => { fetch(request: Request): Promise<Response> }, storage: unknown, name: string, now: () => number): Promise<{ outcome: string; keys?: number; ms: number; reason?: string }>;
export function remoteLine(rpc: unknown, inbox: string, chatId: string): unknown;
export function remoteGroupLine(rpc: unknown, inbox: string, groupId: string): unknown;
