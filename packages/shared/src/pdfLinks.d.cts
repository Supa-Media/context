/** Types for `pdfLinks.cjs`; see that file for the rules and the reasons. */
export declare const MAX_LINKS: number;
export declare const MAX_INFLATED_BYTES: number;
export declare function pdfLinks(bytes: Uint8Array): Promise<string[]>;
