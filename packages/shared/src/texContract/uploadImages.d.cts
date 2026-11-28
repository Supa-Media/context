/** Types for `uploadImages.cjs`; see that file. */

export declare const MAX_IMAGES_PER_WRITE: number;
export declare const MAX_UPLOADED_IMAGE_BYTES: number;
export declare const MAX_UPLOADED_BYTES_PER_WRITE: number;
export declare const SHA256_PATTERN: RegExp;
export declare const UPLOAD_EXTENSIONS: string[];
export declare function embeddedUploadLeaf(noteText: string, leaf: string): string | null;
export declare function uploadLeaf(sha256: string, extension: string): string;
export declare function sha256Hex(bytes: BufferSource): Promise<string>;
export declare function decodeBase64(value: string): Uint8Array | null;
export declare function storableImage(data: unknown): { contentType: string; bytes: number } | null;
export declare function sentPictureLeaf(data: unknown): Promise<{ leaf: string; bytes: number } | null>;
