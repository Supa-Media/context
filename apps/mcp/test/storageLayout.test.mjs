import {
  STORAGE_LAYOUT_ROLLBACK_MS,
  getWithLegacyFallback,
  migrateStorageLayout,
} from "../src/storageLayout.js";
import {
  STORAGE_LAYOUT_MANIFEST_KEY,
  STORAGE_LAYOUT_MIGRATION_KEY,
  currentStorageKey,
} from "../../../packages/shared/src/storageLayout.cjs";

function check(name, ok) {
  if (!ok) throw new Error(`storage layout: ${name}`);
}

function memoryStore(seed = {}) {
  const encoder = new TextEncoder();
  const objects = new Map(
    Object.entries(seed).map(([key, value]) => [key, encoder.encode(value)]),
  );
  return {
    objects,
    capabilities: {
      conditionalCreate: true,
      conditionalWrite: true,
      conditionalDelete: true,
    },
    async get(key) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return {
        etag: String(bytes.byteLength),
        text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () => bytes.slice().buffer,
      };
    },
    async put(key, value, options = {}) {
      if (options.onlyIf?.absent && objects.has(key)) return null;
      if (
        options.onlyIf?.etagMatches &&
        String(objects.get(key)?.byteLength) !== options.onlyIf.etagMatches
      )
        return null;
      const bytes =
        typeof value === "string"
          ? encoder.encode(value)
          : new Uint8Array(value);
      objects.set(key, bytes);
      return { etag: String(bytes.byteLength) };
    },
    async delete(key, options = {}) {
      if (
        options.onlyIf?.etagMatches &&
        String(objects.get(key)?.byteLength) !== options.onlyIf.etagMatches
      )
        return null;
      objects.delete(key);
    },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const next = start + page.length;
      return {
        objects: page.map((key) => ({
          key,
          size: objects.get(key).byteLength,
          uploaded: new Date(),
        })),
        truncated: next < keys.length,
        ...(next < keys.length ? { cursor: String(next) } : {}),
      };
    },
  };
}

export async function runStorageLayoutChecks() {
  const store = memoryStore({
    ".audit/a.json": "audit",
    ".history/a.md.old": "history",
    ".images/picture.png": "image",
    ".index/v2/manifest.json": "index",
    ".meetings/sessions/meeting.json": "meeting",
    ".note-acl/a.json": "acl",
    ".granola-events/pending/a.json": "granola",
    ".proposals/pending/a.json": "proposal",
    ".context-probe/a": "probe",
  });

  let result;
  do {
    result = await migrateStorageLayout(store, { batchSize: 2 });
  } while (result.state === "copying");
  check(
    "a bounded, resumable copy reaches the verified state",
    result.state === "copied",
  );
  for (const key of [
    ".audit/a.json",
    ".history/a.md.old",
    ".images/picture.png",
    ".index/v2/manifest.json",
    ".meetings/sessions/meeting.json",
    ".note-acl/a.json",
    ".granola-events/pending/a.json",
    ".proposals/pending/a.json",
    ".context-probe/a",
  ]) {
    check(
      `${key} is copied under .context`,
      store.objects.has(currentStorageKey(key)),
    );
    check(`${key} remains during the rollback window`, store.objects.has(key));
  }
  check(
    "the schema manifest is written",
    store.objects.has(STORAGE_LAYOUT_MANIFEST_KEY),
  );
  check(
    "migration progress is durable",
    store.objects.has(STORAGE_LAYOUT_MIGRATION_KEY),
  );

  const copiedAgain = await migrateStorageLayout(store, { batchSize: 100 });
  check(
    "copy is idempotent",
    copiedAgain.objectsCopied === result.objectsCopied,
  );
  const earlyCleanup = await migrateStorageLayout(store, { cleanup: true });
  check(
    "cleanup waits for the rollback window",
    /seven-day/.test(earlyCleanup.error || ""),
  );

  let cleanup;
  const cleanupNow = Date.parse(result.copiedAt) + STORAGE_LAYOUT_ROLLBACK_MS;
  do {
    cleanup = await migrateStorageLayout(store, {
      batchSize: 3,
      cleanup: true,
      now: {
        toISOString: () => new globalThis.Date(cleanupNow).toISOString(),
        getTime: () => cleanupNow,
      },
    });
  } while (cleanup.state === "cleaning");
  check(
    `cleanup completes separately (${JSON.stringify(cleanup)})`,
    cleanup.state === "complete",
  );
  check(
    "cleanup removes only legacy objects",
    ![...store.objects.keys()].some((key) => currentStorageKey(key) !== key),
  );

  const fallback = memoryStore({ ".images/legacy.png": "legacy" });
  check(
    "dual-read compatibility reaches a legacy object",
    (await (
      await getWithLegacyFallback(
        fallback,
        currentStorageKey(".images/legacy.png"),
      )
    ).text()) === "legacy",
  );

  const conflict = memoryStore({
    ".audit/a.json": "old",
    [currentStorageKey(".audit/a.json")]: "different",
  });
  const refused = await migrateStorageLayout(conflict);
  check("a destination conflict stops migration", refused.state === "conflict");
  check(
    "a conflict never overwrites the destination",
    new TextDecoder().decode(
      conflict.objects.get(currentStorageKey(".audit/a.json")),
    ) === "different",
  );

  const corrupt = memoryStore({
    [STORAGE_LAYOUT_MIGRATION_KEY]: '{"prefixIndex":-1}',
  });
  let corruptRefused = false;
  try {
    await migrateStorageLayout(corrupt);
  } catch (error) {
    corruptRefused = /unsupported shape/.test(error.message);
  }
  check(
    "hand-edited migration state is refused before any path is selected",
    corruptRefused,
  );
}
