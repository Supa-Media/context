// The gateway's door into this Worker's inbound code (`gatewayInbound.js`), declared loosely: the types that matter are
// checked by this Worker's own config, on the files it re-exports.
export type Tapback = "Loved" | "Liked" | "Disliked" | "Laughed at" | "Emphasized" | "Questioned" | "Reacted";
export type Reaction = { how: Tapback; words: string; removed?: true; onOther?: true; onTex?: true; emoji?: string; otherWords?: string };
export type InboundAttachment = { url: string; mimeType: string; filename: string; size: number | null };
export function kindOf(text: string, attachments?: readonly { filename: string; mimeType: string }[]): string;
export function answers(reaction: Reaction): boolean;
export const EMOJI: Record<Tapback, string>;
export function reactionLine(reaction: Reaction, onTex: boolean): string;
export function tapbackText(how: Tapback): string;
export function holdsAsAnswer(reaction: Reaction): boolean;
export function onMachineAsk(reaction: Reaction): boolean;
export function prepareAttachments(list: InboundAttachment[], deps: { fetch: (input: string, init?: RequestInit) => Promise<Response>; images?: unknown }): Promise<Array<Record<string, string>>>;
export function filesFor(message: { attachments?: InboundAttachment[] }, lines: readonly { attachments?: InboundAttachment[] }[]): InboundAttachment[];
export const MAX_GROUP_FILES: number;
export const PICTURE_LINE: string;
export const MAX_QUOTED_TEXT: number;
export const EFFECT_NAMES: Readonly<Record<string, string>>;
export function richWords(message: Record<string, unknown>, card: boolean): string;
