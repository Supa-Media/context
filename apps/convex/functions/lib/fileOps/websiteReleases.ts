/** Customer-owned, immutable fallback copies for bucket-backed website pages. */

import { WEBSITE_RELEASE_PREFIX } from "@context/shared/src/storageLayout.cjs";
import type { Clearance } from "../clearance";
import { FileOpError } from "./errors";
import { readFile } from "./reading";
import type { FileStore } from "./store";

const RELEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RELEASE_BATCH = 50;
const MAX_RELEASE_OBJECTS = 500;

function releaseKey(releaseId: string, pageId: string): string {
  if (!RELEASE_ID.test(releaseId) || !RELEASE_ID.test(pageId)) {
    throw new FileOpError("PATH_INVALID", "That website release reference is not valid.");
  }
  return `${WEBSITE_RELEASE_PREFIX}${releaseId}/${pageId}.md`;
}

export async function writeWebsiteRelease(
  store: FileStore,
  clearance: Clearance,
  options: {
    releaseId: string;
    pages: Array<{ pageId: string; path: string; expectedEtag: string }>;
  },
): Promise<number> {
  if (options.pages.length > MAX_RELEASE_BATCH) {
    throw new FileOpError("BATCH_TOO_LARGE", "That website release batch is too large.");
  }
  for (const page of options.pages) {
    const current = await readFile(store, { path: page.path, clearance });
    if (current.etag !== page.expectedEtag) {
      throw new FileOpError(
        "CONFLICT",
        "A website page changed while its release was being prepared.",
        current.etag,
      );
    }
    const key = releaseKey(options.releaseId, page.pageId);
    const prior = await store.get(key);
    if (prior !== null) {
      if ((await prior.text()) === current.text) continue;
      throw new FileOpError(
        "CONFLICT",
        "A website release object already contains different bytes.",
      );
    }
    const written =
      store.capabilities?.conditionalCreate === true
        ? await store.put(key, current.text, { onlyIf: { absent: true } })
        : await store.put(key, current.text);
    if (written === null) {
      // Action retries are allowed to revisit a completed immutable write.
      const existing = await store.get(key);
      if (existing === null || (await existing.text()) !== current.text) {
        throw new FileOpError(
          "CONFLICT",
          "A website release object already contains different bytes.",
        );
      }
    }
    const verified = await store.get(key);
    if (verified === null || (await verified.text()) !== current.text) {
      throw new FileOpError(
        "CONFLICT",
        "The bucket did not preserve the website release bytes it accepted.",
      );
    }
  }
  return options.pages.length;
}

export async function readWebsiteRelease(
  store: FileStore,
  pages: Array<{ releaseId: string; pageId: string; path: string }>,
): Promise<
  Array<{ path: string; outcome: "read"; text: string } | { path: string; outcome: "missing" }>
> {
  if (pages.length > MAX_RELEASE_BATCH) {
    throw new FileOpError("BATCH_TOO_LARGE", "That website release read is too large.");
  }
  return await Promise.all(
    pages.map(async (page) => {
      const object = await store.get(releaseKey(page.releaseId, page.pageId));
      return object === null
        ? { path: page.path, outcome: "missing" as const }
        : {
            path: page.path,
            outcome: "read" as const,
            text: await object.text(),
          };
    }),
  );
}

export async function deleteWebsiteRelease(store: FileStore, releaseId: string): Promise<number> {
  // Validate before using a value as a prefix. A malformed empty id must never
  // turn cleanup of one retired release into cleanup of the whole namespace.
  releaseKey(releaseId, "00000000-0000-4000-8000-000000000000");
  const prefix = `${WEBSITE_RELEASE_PREFIX}${releaseId}/`;
  let cursor: string | undefined;
  const seen = new Set<string>();
  const keys: string[] = [];
  do {
    const page = await store.list({
      prefix,
      limit: MAX_RELEASE_OBJECTS + 1,
      ...(cursor === undefined ? {} : { cursor }),
    });
    keys.push(...page.objects.map((object) => object.key));
    if (keys.length > MAX_RELEASE_OBJECTS) {
      throw new FileOpError(
        "FOLDER_TOO_LARGE",
        "That website release is too large to clean up safely.",
      );
    }
    const next = page.cursor;
    if (page.truncated && next === undefined) {
      throw new FileOpError(
        "LISTING_INCOMPLETE",
        "The bucket could not finish listing that website release.",
      );
    }
    if (next !== undefined && (next === cursor || seen.has(next))) {
      throw new FileOpError(
        "LISTING_INCOMPLETE",
        "The bucket repeated part of that website release listing.",
      );
    }
    if (next !== undefined) seen.add(next);
    cursor = page.truncated ? next : undefined;
  } while (cursor !== undefined);
  for (const key of keys) await store.delete(key);
  return keys.length;
}
