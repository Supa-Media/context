/** Types for `texTraining.cjs`; see that file. */
import type { Conversation, Label, Message } from "./texSets.cjs";

export type Moment = { chat: string; kind: "one" | "group"; setting?: string; before: string[]; newest: string; label: Omit<Label, "star"> };
export type Generated = { about?: string; nodes: Record<string, Moment[]> };
export const TRAIN_ENTRY: RegExp;
export const QUOTE_CHARS: number;
export const TRAINING_INTRO: string;
export function lineOf(m: Message, earlier: Message[]): string;
export function linesBefore(c: Conversation, at: number): string[];
export function momentsOf(conversations: Conversation[]): Record<string, Moment[]>;
export function trainingSources(step: { ctx?: string[] } | undefined): string[];
export function wantLines(label: Moment["label"]): string[];
export function exampleText(moment: Moment): string;
export function trainingText(step: { ctx?: string[] } | undefined, generated: Generated): string;
export function moduleText(entry: string, generated: Generated): string;
