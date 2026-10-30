/** Types for `index.cjs` (pages); see the `.cjs` files for the format and the reasons. */

export interface PageRun {
  text: string;
  from: number;
  to: number;
  editable?: boolean;
  strong?: boolean;
  em?: boolean;
  strike?: boolean;
  code?: boolean;
  href?: string;
  note?: string;
  anchors: string[];
  image?: { src: string; alt: string };
}

export interface PageProblem {
  message: string;
  from: number;
}

export interface PageNode {
  type: "heading" | "paragraph" | "rule" | "list" | "quote" | "table" | "code" | "block" | "box" | "css";
  from: number;
  to: number;
  kind?: string;
  [key: string]: unknown;
}

export interface ParsedPage {
  fields: Record<string, string>;
  bodyStart: number;
  title: string;
  nodes: PageNode[];
  problems: PageProblem[];
}

export type PageEditResult = { text: string; error?: undefined } | { error: string; text?: undefined };

export declare const PAGE_SUFFIX: ".page.md";
export declare function isPagePath(path: string): boolean;
export declare function parsePage(source: string): ParsedPage;
export declare const BLOCK_KINDS: Record<string, { about: string; settings: string[] }>;
export declare function renderPage(
  page: ParsedPage,
  options?: { open?: Set<string>; cover?: boolean },
): { html: string; boxes: PageNode[]; css: string[] };
export declare function pageData(page: ParsedPage): unknown;
export declare function pageTokens(fields: Record<string, string>, viewerDark: boolean): { dark: boolean; vars: string };
export declare const BASE_CSS: string;
export declare function escapeText(text: string): string;
export declare function sourceOffset(source: string, from: number, to: number, offset: number): number;
export declare function applyRunEdits(source: string, edits: { from: number; to: number; text: string }[]): PageEditResult;
export declare function toggleTask(source: string, at: number, checked: boolean): PageEditResult;
export declare function chooseOption(source: string, blockFrom: number, option: string): PageEditResult;
export declare function castVote(source: string, blockFrom: number, option: string, author: string): PageEditResult;
export declare function commentableRange(source: string, from: number, to: number): boolean;
