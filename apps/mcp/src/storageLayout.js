import {
  LEGACY_STORAGE_PREFIXES,
  STORAGE_LAYOUT_MANIFEST_KEY,
  STORAGE_LAYOUT_MIGRATION_KEY,
  STORAGE_LAYOUT_VERSION,
  legacyStorageKey,
} from "../../../packages/shared/src/storageLayout.cjs";

const DEFAULT_BATCH_SIZE = 8;
const MAX_BATCH_SIZE = 8;
const STATE_BYTE_CAP = 128_000;
export const STORAGE_LAYOUT_ROLLBACK_MS = 7 * 24 * 60 * 60 * 1000;
const PRESERVED_CONTENT_TYPES = new Set([
  "text/markdown; charset=utf-8",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/octet-stream",
]);

function bytesEqual(left, right) {
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

async function readJson(store, key) {
  const object = await store.get(key);
  if (!object) return { value: null, etag: null };
  try {
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength > STATE_BYTE_CAP) throw new Error("oversized");
    return {
      value: JSON.parse(new TextDecoder().decode(bytes)),
      etag: object.etag,
    };
  } catch {
    throw new Error(`storage layout state is invalid at ${key}`);
  }
}

async function writeState(store, state, etag) {
  const result = await store.put(
    STORAGE_LAYOUT_MIGRATION_KEY,
    JSON.stringify(state, null, 2),
    {
      onlyIf: etag ? { etagMatches: etag } : { absent: true },
    },
  );
  if (!result) throw new Error("storage layout migration is already running");
  return result.etag;
}

async function copyWithoutOverwrite(store, sourceKey, destinationKey) {
  const source = await store.get(sourceKey);
  if (!source) return { status: "missing", sourceEtag: null };
  const sourceBytes = await source.arrayBuffer();
  const existing = await store.get(destinationKey);
  if (existing) {
    return {
      status: bytesEqual(sourceBytes, await existing.arrayBuffer())
        ? "verified"
        : "conflict",
      sourceEtag: source.etag,
    };
  }
  if (!store.capabilities?.conditionalCreate)
    return { status: "unsupported", sourceEtag: source.etag };
  const sourceContentType =
    source.contentType || source.httpMetadata?.contentType;
  const written = await store.put(destinationKey, sourceBytes, {
    onlyIf: { absent: true },
    ...(PRESERVED_CONTENT_TYPES.has(sourceContentType)
      ? { contentType: sourceContentType }
      : {}),
  });
  const destination = await store.get(destinationKey);
  if (!destination) return { status: "conflict", sourceEtag: source.etag };
  return {
    status: bytesEqual(sourceBytes, await destination.arrayBuffer())
      ? "copied"
      : "conflict",
    sourceEtag: source.etag,
  };
}

async function writeManifest(store, now) {
  const current = await store.get(STORAGE_LAYOUT_MANIFEST_KEY);
  if (current) {
    try {
      const parsed = JSON.parse(await current.text());
      if (parsed?.schemaVersion === STORAGE_LAYOUT_VERSION) return;
    } catch {
      // Refused below: a reserved object we do not understand is never overwritten.
    }
    throw new Error("storage layout manifest conflicts with layout v1");
  }
  const result = await store.put(
    STORAGE_LAYOUT_MANIFEST_KEY,
    JSON.stringify(
      { schemaVersion: STORAGE_LAYOUT_VERSION, migratedAt: now },
      null,
      2,
    ),
    { onlyIf: { absent: true } },
  );
  if (!result)
    throw new Error("storage layout manifest changed during migration");
}

function freshState(now) {
  return {
    migration: "storage-layout-v1",
    version: STORAGE_LAYOUT_VERSION,
    state: "copying",
    prefixIndex: 0,
    cursor: null,
    objectsCopied: 0,
    objectsVerified: 0,
    objectsDeleted: 0,
    conflicts: [],
    startedAt: now,
    updatedAt: now,
  };
}

function validState(state) {
  const states = new Set([
    "copying",
    "copied",
    "cleaning",
    "conflict",
    "unsupported",
    "complete",
  ]);
  return Boolean(
    state &&
    state.migration === "storage-layout-v1" &&
    state.version === STORAGE_LAYOUT_VERSION &&
    states.has(state.state) &&
    Number.isInteger(state.prefixIndex) &&
    state.prefixIndex >= 0 &&
    state.prefixIndex <= LEGACY_STORAGE_PREFIXES.length &&
    (state.cursor === null || typeof state.cursor === "string") &&
    Number.isInteger(state.objectsCopied) &&
    state.objectsCopied >= 0 &&
    Number.isInteger(state.objectsVerified) &&
    state.objectsVerified >= 0 &&
    Number.isInteger(state.objectsDeleted) &&
    state.objectsDeleted >= 0 &&
    Array.isArray(state.conflicts) &&
    state.conflicts.every((key) => typeof key === "string"),
  );
}

/** Read a v1 plumbing object, falling back to its pre-v1 key. */
export async function getWithLegacyFallback(store, key, options = {}) {
  const current = await store.get(key);
  if (current) return current;
  const legacy = legacyStorageKey(key);
  if (!legacy) return null;
  if (options.beforeFallback && options.beforeFallback() === false) return null;
  return store.get(legacy);
}

/** Delete a v1 plumbing object and any pre-v1 copy that could resurrect it. */
export async function deleteWithLegacyFallback(store, key, options) {
  const legacy = legacyStorageKey(key);
  if (!legacy) return store.delete(key, options);
  const current = await store.get(key);
  if (!current) return store.delete(legacy, options);
  const deleted = await store.delete(key, options);
  if (deleted === null) return null;
  await store.delete(legacy);
  return deleted;
}

/**
 * Copy or clean up one bounded batch of legacy plumbing objects.
 *
 * Copy is deliberately non-destructive. Cleanup is a separate explicit phase
 * and is refused until every source object has an identical v1 destination.
 */
export async function migrateStorageLayout(store, options = {}) {
  const nowDate =
    options.now && typeof options.now.toISOString === "function"
      ? options.now
      : new Date();
  const now = nowDate.toISOString();
  const batchSize = Math.min(
    MAX_BATCH_SIZE,
    Math.max(
      1,
      Number.isInteger(options.batchSize)
        ? options.batchSize
        : DEFAULT_BATCH_SIZE,
    ),
  );
  if (
    !store.capabilities?.conditionalCreate ||
    !store.capabilities?.conditionalWrite
  ) {
    return {
      ...freshState(now),
      state: "unsupported",
      error: "migration requires conflict-safe storage writes",
    };
  }
  const persisted = await readJson(store, STORAGE_LAYOUT_MIGRATION_KEY);
  if (persisted.value !== null && !validState(persisted.value)) {
    throw new Error("storage layout migration state has an unsupported shape");
  }
  let state = persisted.value || freshState(now);
  let stateEtag = persisted.etag;
  const cleanup = options.cleanup === true;
  if (cleanup && !store.capabilities?.conditionalDelete) {
    return {
      ...state,
      error: "cleanup requires conflict-safe storage deletes",
    };
  }
  if (
    cleanup &&
    state.state !== "copied" &&
    state.state !== "cleaning" &&
    state.state !== "complete" &&
    !(state.state === "conflict" && state.cleanupStartedAt)
  ) {
    return {
      ...state,
      error: "cleanup requires a completed and verified copy phase",
    };
  }
  if (!cleanup && state.state === "complete") return state;
  if (!cleanup && state.state === "copied") return state;
  if (!cleanup && state.state === "cleaning") {
    return { ...state, error: "cleanup is already in progress" };
  }
  if (cleanup && state.state === "complete") return state;
  if (cleanup && state.state === "copied") {
    const copiedAt = Date.parse(state.copiedAt || "");
    if (
      !Number.isFinite(copiedAt) ||
      nowDate.getTime() - copiedAt < STORAGE_LAYOUT_ROLLBACK_MS
    ) {
      return {
        ...state,
        error:
          "cleanup is unavailable until the seven-day rollback window ends",
      };
    }
    state = {
      ...state,
      state: "cleaning",
      cleanupStartedAt: now,
      prefixIndex: 0,
      cursor: null,
    };
  } else if (cleanup && state.state === "conflict") {
    state = { ...state, state: "cleaning" };
  }

  let remaining = batchSize;
  let pagesRead = 0;
  const seenCursors = new Set();
  while (remaining > 0 && state.prefixIndex < LEGACY_STORAGE_PREFIXES.length) {
    if (pagesRead >= LEGACY_STORAGE_PREFIXES.length + batchSize) {
      throw new Error(
        "storage layout migration exceeded its listing-page budget",
      );
    }
    pagesRead += 1;
    const [legacyPrefix, currentPrefix] =
      LEGACY_STORAGE_PREFIXES[state.prefixIndex];
    const page = await store.list({
      prefix: legacyPrefix,
      cursor: state.cursor || undefined,
      limit: remaining,
    });
    if (!Array.isArray(page.objects) || page.objects.length > remaining) {
      throw new Error(
        "storage layout migration received an invalid listing page",
      );
    }
    for (const object of page.objects) {
      const destinationKey = `${currentPrefix}${object.key.slice(legacyPrefix.length)}`;
      if (cleanup) {
        const result = await copyWithoutOverwrite(
          store,
          object.key,
          destinationKey,
        );
        if (result.status === "conflict" || result.status === "unsupported") {
          state.conflicts = [...state.conflicts, object.key].slice(-100);
          state.state = "conflict";
          state.updatedAt = now;
          await writeState(store, state, stateEtag);
          return state;
        }
        if (result.status !== "missing") {
          const deleted = await store.delete(object.key, {
            onlyIf: { etagMatches: result.sourceEtag },
          });
          if (deleted === null) {
            state.conflicts = [...state.conflicts, object.key].slice(-100);
            state.state = "conflict";
            state.updatedAt = now;
            await writeState(store, state, stateEtag);
            return state;
          }
          state.objectsDeleted += 1;
        }
      } else {
        const result = await copyWithoutOverwrite(
          store,
          object.key,
          destinationKey,
        );
        if (result.status === "conflict" || result.status === "unsupported") {
          state.conflicts = [...state.conflicts, object.key].slice(-100);
          state.state =
            result.status === "unsupported" ? "unsupported" : "conflict";
          state.updatedAt = now;
          await writeState(store, state, stateEtag);
          return state;
        }
        if (result.status === "copied") state.objectsCopied += 1;
        if (result.status === "verified") state.objectsVerified += 1;
      }
      remaining -= 1;
    }
    if (page.truncated) {
      if (
        !page.cursor ||
        page.cursor === state.cursor ||
        seenCursors.has(page.cursor)
      ) {
        throw new Error("storage layout migration received an invalid cursor");
      }
      seenCursors.add(page.cursor);
      state.cursor = page.cursor;
    } else {
      state.prefixIndex += 1;
      state.cursor = null;
    }
  }

  if (state.prefixIndex >= LEGACY_STORAGE_PREFIXES.length) {
    state.state = cleanup ? "complete" : "copied";
    state.completedAt = now;
    if (!cleanup) state.copiedAt = now;
    state.prefixIndex = LEGACY_STORAGE_PREFIXES.length;
    state.cursor = null;
    if (!cleanup) {
      await writeManifest(store, now);
    }
  }
  state.updatedAt = now;
  stateEtag = await writeState(store, state, stateEtag);
  return state;
}
