/** Types for `notePreview.cjs`; see that file for the rules and the reasons. */

import type { TexPose } from "./ink/texPoses.cjs";

export type NoteBoard = "notebook" | "ink" | "paper" | "graph" | "kraft" | "chalk" | "blueprint";

export declare const BOARDS: readonly NoteBoard[];
export declare const KEY_PATTERN: RegExp;
export declare const MAX_TITLE: number;
export declare function previewSigningKey(secret: unknown): Promise<CryptoKey | null>;
export declare function previewKey(signingKey: CryptoKey, link: { slug: string; path: string; title: string }): Promise<string>;
export declare function isPreviewKey(
  signingKey: CryptoKey | null,
  link: { slug: unknown; path: unknown; title: unknown; key: unknown },
): Promise<boolean>;
export declare function cleanTitle(value: unknown): string;
export declare function noteTitleOf(path: string, text?: string | null): string;
export declare function folderLineOf(path: string): string;
export declare function boardOf(slug: string, path: string): NoteBoard;
export declare function poseOf(title: string, path: string): TexPose | null;
export declare function withPreviewLinks(text: string, signed: Map<string, string>): string;
