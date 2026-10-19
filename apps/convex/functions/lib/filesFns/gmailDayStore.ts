/**
 * The store a Gmail pass writes its days through: an existing day note is
 * rewritten through its collaboration document, like a Calendar day
 * (`writeSharedCalendarDay`) and like any save (`fileOps/writing.ts`).
 *
 * A day note someone has opened has a collaboration document, and every read
 * is materialized from it: one whose Markdown changed outside collaboration is
 * repaired back to the document's text (`finalizePending` in
 * `@context/collaboration`). `writeDayPart` used to `put` the Markdown alone,
 * so each later pass's mail was written and then undone by the next read, and
 * the day stayed at whatever it held when it was first opened (production,
 * 2026-10-19: a mailbox's days kept only their first hours). Here `get`
 * answers with the document's text and etag, and a `put` over that etag goes
 * through `replaceText`, so the day as read is the day as synced.
 *
 * Only day notes are routed. The day cache, the manifest and Contact pages
 * keep the plain store, and so does a day not yet written: creating it is an
 * ordinary write.
 */

import {
  eligible as collaborationEligible,
  readDocument as readCollaborationDocument,
  replaceText as replaceCollaborationText,
  supported as collaborationSupported,
} from "@context/collaboration";
import type { FileStore } from "../fileOps";

/** `…/2026-10-19.md` and its overflow parts, `…/2026-10-19-part-2.md`. */
const DAY_NOTE = /\/\d{4}-\d{2}-\d{2}(?:-part-\d+)?\.md$/;

/** A conflict the caller's read-compare-write loop answers by reading again. */
const RETRYABLE = new Set(["CONCURRENT_WRITE", "BASE_MISSING", "GENERATION_MISMATCH"]);

function codeOf(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

export function gmailDayStore(store: FileStore, folder: string | undefined): FileStore {
  if (!collaborationSupported(store)) return store;
  const isDay = (key: string) => DAY_NOTE.test(key) && (folder === undefined || key.startsWith(`${folder}/`));

  const get: FileStore["get"] = async (key) => {
    const raw = await store.get(key);
    if (raw === null || !isDay(key)) return raw;
    const text = await raw.text();
    if (!collaborationEligible(key, text)) {
      return { ...raw, text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer };
    }
    const document = await readCollaborationDocument(store, key);
    return {
      etag: document.etag,
      text: async () => document.text,
      arrayBuffer: async () => new TextEncoder().encode(document.text).buffer as ArrayBuffer,
    };
  };

  const put: FileStore["put"] = async (key, value, options) => {
    const expectedEtag = options?.onlyIf?.etagMatches;
    if (!isDay(key) || typeof value !== "string" || expectedEtag === undefined || !collaborationEligible(key, value)) {
      return await store.put(key, value, options);
    }
    try {
      const current = await readCollaborationDocument(store, key);
      const replaced = await replaceCollaborationText(store, key, {
        documentId: current.documentId,
        expectedEtag,
        text: value,
      });
      return { etag: replaced.etag };
    } catch (error) {
      // `null` is the store's own "someone wrote first": `writeDayPart` reads again and retries.
      if (RETRYABLE.has(codeOf(error) ?? "")) return null;
      throw error;
    }
  };

  // Spelled out rather than a Proxy: the HTTP route check must resolve every member statically.
  return {
    get,
    put,
    list: (options) => store.list(options),
    delete: (key, options) => store.delete(key, options),
    ...(store.head === undefined ? {} : { head: (key: string) => store.head!(key) }),
    capabilities: store.capabilities,
  };
}
