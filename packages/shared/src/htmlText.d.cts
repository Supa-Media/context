/** Types for `htmlText.cjs`; see that file for the rules and the reasons. */

export declare const MAX_LINKS: number;
export declare const MAX_LINK_CHARS: number;

export declare function htmlToText(html: string, maxChars: number, onStep?: () => void, options?: { links?: boolean }): string;

export declare function keptLinks(rendered: string): string[];

export declare function preferredBody(plain: string, rendered: string): { text: string; source: "plain" | "html" | "none" };
