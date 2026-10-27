/** Types for `contextIcons.cjs`; see that file for what the set is and how one is stored. */

export type ContextIconFamily =
  | "work"
  | "money"
  | "home"
  | "people"
  | "learning"
  | "making"
  | "health"
  | "travel"
  | "nature"
  | "community"
  | "things"
  | "symbols";

export interface ContextIcon {
  /** Its name in `context:icon:<name>` and in the drawings. */
  readonly name: string;
  /** What the picker and a screen reader call it. */
  readonly label: string;
  /** Its emoji twin, written wherever a drawing can't go. */
  readonly emoji: string;
  readonly family: ContextIconFamily;
  /** Lowercase words, space-separated, that search and the suggestion read. */
  readonly words: string;
}

export type ContextPart = keyof typeof PART_EMOJI;

export declare const CONTEXT_ICON_PREFIX: "context:icon:";
export declare const CONTEXT_PART_PREFIX: "context:part:";
export declare const CONTEXT_ICON_FAMILIES: readonly ContextIconFamily[];
export declare const CONTEXT_ICON_FAMILY_LABEL: Readonly<Record<ContextIconFamily, string>>;
export declare const CONTEXT_ICONS: readonly ContextIcon[];
export declare const PART_EMOJI: Readonly<{
  tex_about: string;
  tex_attention: string;
  tex_dreams: string;
  tex_heartbeat: string;
  tex_housekeeping: string;
  tex_jobs: string;
  tex_chats: string;
  tex_groups: string;
  tex_handbacks: string;
  tex_routines: string;
  tex_skills: string;
  tex_transcripts: string;
  cadence_once: string;
  cadence_minute: string;
  cadence_hour: string;
  cadence_day: string;
  cadence_week: string;
  cadence_month: string;
  cadence_year: string;
  inbox_calendar: string;
  inbox_contacts: string;
  inbox_email: string;
  inbox_forms: string;
  inbox_chat: string;
  inbox_imessage: string;
  inbox_meetings: string;
  inbox_memories: string;
  inbox_sessions: string;
  inbox_capture: string;
  inbox_granola: string;
}>;
export declare function contextIconMarker(name: string): string;
export declare function contextIconOf(icon: string | null | undefined): ContextIcon | null;
export declare function contextPartMarker(name: ContextPart): string;
export declare function contextPartOf(icon: string | null | undefined): ContextPart | null;
export declare function iconAsText(icon: string): string;
export declare function searchContextIcons(query: string): ContextIcon[];
export declare function randomContextIcon(random?: () => number, not?: string | null): string;
