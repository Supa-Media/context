/** Types for `searchSettings.cjs`; see that file. */

type Bound = { readonly min: number; readonly max: number; readonly integer: boolean };
export declare const PERSON_SEARCH_BOUNDS: { readonly minScore: Bound; readonly extraNotes: Bound; readonly snippetChars: Bound };
export declare const SEARCH_SETTING_KEYS: Readonly<Record<"everywhere" | "min_score" | "extra_notes" | "snippet_chars", string>>;
export declare function readSearchSettings(raw: unknown): { everywhere?: boolean; minScore?: number; extraNotes?: number; snippetChars?: number } | null;
