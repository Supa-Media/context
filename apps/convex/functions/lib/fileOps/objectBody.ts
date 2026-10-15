/**
 * What a move or copy writes at the new name: the object's bytes, never its
 * text, and the type it was stored as where that is one a store may write.
 * Decoding as text replaced every byte that is not valid UTF-8, so an image
 * moved with its folder came out broken (`__tests__/fileOps/binaryMoves.test.ts`).
 *
 * A type no store may write (a PDF put in the customer's own bucket by
 * something else) lands as an attachment, never as Markdown: a browser will
 * not run it, and nothing reads it as a note.
 */

import {
  ATTACHMENT_CONTENT_TYPE,
  LOGICAL_DELETE_CONTENT_TYPE,
  WRITABLE_CONTENT_TYPES,
} from "../../../../mcp/src/store/contentTypes.js";

interface StoredObject {
  arrayBuffer(): Promise<ArrayBuffer>;
  contentType?: string;
  httpMetadata?: { contentType?: string };
}

export async function objectBody(
  key: string,
  object: StoredObject,
): Promise<{ body: ArrayBuffer; contentType?: string }> {
  const body = await object.arrayBuffer();
  const type = object.contentType ?? object.httpMetadata?.contentType;
  if (typeof type === "string" && type !== LOGICAL_DELETE_CONTENT_TYPE && WRITABLE_CONTENT_TYPES.has(type)) {
    return { body, contentType: type };
  }
  return key.toLowerCase().endsWith(".md") ? { body } : { body, contentType: ATTACHMENT_CONTENT_TYPE };
}
