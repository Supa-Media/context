// The gateway's door into this Worker's chat code (`gatewayChat.js`), declared loosely: the types that matter are
// checked by this Worker's own config, on the files it re-exports.
export const SenderInbox: new (state: unknown, env: unknown) => { fetch(request: Request): Promise<Response>; alarm(): Promise<void> };
export function arrive(stubs: (name: string) => { fetch(request: Request): Promise<Response> }, storage: unknown, name: string, now: () => number): Promise<{ outcome: string; keys?: number; ms: number; reason?: string }>;
export function remoteLine(rpc: unknown, inbox: string, chatId: string): unknown;
export function remoteGroupLine(rpc: unknown, inbox: string, groupId: string): unknown;
export function setChatBound(storage: unknown, bound: unknown | null, muted?: boolean): Promise<void>;
export function appLine(storage: unknown, now?: () => number): unknown;
export function isAppChat(chatId: unknown): boolean;
export function appUserOf(chatId: string): string | null;
export const APP_TYPING_KEY: "app:typing";
export const APP_PICTURE_ORIGIN: "https://app-chat.invalid";
export function keepAppPicture(storage: unknown, bytes: Uint8Array, now: number): Promise<string | null>;
export function readAppPicture(storage: unknown, id: string): Promise<{ mediaType: string; bytes: Uint8Array } | null>;
export function forgetAppPicture(storage: unknown, id: string): Promise<void>;
export function serveAppPicture(storage: unknown, url: string): Promise<Response>;
export const APP_FILE_TYPES: ReadonlySet<string>;
export const MAX_APP_FILE_BYTES: 10000000;
export function appFileIdOf(url: string): string | null;
export function appFileUrl(id: string, name: string): string;
export function forgetAppFile(storage: unknown, id: string): Promise<void>;
export function keepAppFile(storage: unknown, bytes: Uint8Array, name: string, now: number): Promise<string | null>;
export function readAppFile(storage: unknown, id: string): Promise<{ mediaType: string; name: string; bytes: Uint8Array } | null>;
export function safeAppFileName(raw: string): string;
export function serveAppFile(storage: unknown, url: string): Promise<Response>;
export function sniffAppFile(bytes: Uint8Array, name: string): string | null;
export const HANDLES_KEY: "evhandles";
