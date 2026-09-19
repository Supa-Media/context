import {
  STORAGE_LAYOUT_ROLLBACK_MS,
  getWithLegacyFallback,
  migrateStorageLayout,
  readStorageLayoutState,
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

/**
 * Reading the state without running the migration.
 *
 * The state has always been in the bucket and the only thing that ever read it
 * was the migration itself, so "has this bucket been migrated?" could only be
 * answered by migrating. That is what left an already-migrated context being
 * offered the update for ever: the control plane had nothing recorded, and
 * absent was read as "nobody has run it" rather than "nobody has looked".
 *
 * The two are different answers and the shape says so. `observed` is whether
 * the bucket told us anything at all; `state` is what it said, `null` for a
 * bucket that genuinely has never run this. A caller that collapsed the two
 * would record a false absence, which is the nag again with extra steps.
 */
export async function runStorageLayoutReadChecks() {
  const never = memoryStore({ ".audit/a.json": "legacy" });
  const fresh = await readStorageLayoutState(never);
  check(
    "a bucket nobody has migrated is observed to have no state",
    fresh.observed === true && fresh.state === null,
  );
  check("reading the state writes nothing", never.objects.size === 1);

  /*
    THE BUCKET THAT WAS OFFERED AN UPDATE IT COULD NOT NEED.

    An absent state file was the whole answer, so a context we scaffolded
    ourselves — born on the v1 layout, never in its life the owner of a
    `.audit/` or a `.history/` — was indistinguishable from a bucket that
    predates `.context/` and still has all of it to move. Every newly created
    workspace was therefore offered the one-time update on its first console
    load, and dismissing it was the only thing that ever ended it.

    Nothing to move is `complete`: the same answer a migrated bucket gives,
    because it is the same fact about the hidden files.
  */
  const born = memoryStore({
    "index.md": "# Context",
    "privacy.md": "rules",
    "1-projects/a.md": "note",
    ".context/manifest.json": '{"schemaVersion":1}',
  });
  const nothingToDo = await readStorageLayoutState(born);
  check(
    "a bucket that never held pre-v1 plumbing is already on the layout",
    nothingToDo.observed === true && nothingToDo.state === "complete",
  );
  check("and answering that question writes nothing", born.objects.size === 4);

  /*
    The sabotage guard for the case above, and the one that matters: a bucket
    with legacy objects still in it is unmigrated however empty the rest of it
    looks, and `complete` there would retire an offer with work behind it —
    pre-v1 plumbing left where no screen mentions it.
  */
  for (const legacy of [
    ".audit/a.json",
    ".history/a.md.old",
    ".images/p.png",
    ".index/v2/manifest.json",
    ".meetings/sessions/m.json",
    ".note-acl/a.json",
    ".granola-events/pending/a.json",
    ".proposals/pending/a.json",
    ".context-probe/a",
  ]) {
    const waiting = await readStorageLayoutState(memoryStore({ [legacy]: "x" }));
    check(
      `${legacy} keeps the bucket unmigrated`,
      waiting.observed === true && waiting.state === null,
    );
  }

  /*
    And a bucket that will not answer the listing is not read as empty. Closing
    the offer on a bucket we could not see into is the one failure here that is
    silent and permanent, so an unreadable store falls back to the answer this
    whole check replaced.
  */
  const listRefused = memoryStore();
  listRefused.list = async () => {
    throw new Error("bucket said no");
  };
  const unknown = await readStorageLayoutState(listRefused);
  check(
    "a listing that fails does not retire the offer",
    unknown.observed === true && unknown.state === null,
  );

  const noList = memoryStore();
  delete noList.list;
  const oldStore = await readStorageLayoutState(noList);
  check(
    "nor does a store too old to list at all",
    oldStore.observed === true && oldStore.state === null,
  );

  const migrated = memoryStore({ ".audit/a.json": "legacy" });
  const done = await migrateStorageLayout(migrated);
  check("the fixture actually migrated", done.state === "copied");
  const after = await readStorageLayoutState(migrated);
  check(
    "a migrated bucket reports what its own state file says",
    after.observed === true && after.state === "copied",
  );

  /*
    The read is a question, not a checkpoint. A bucket that cannot do
    conditional writes can never run the migration, but that is the
    *migration's* refusal to record on the path that refuses — inventing
    `unsupported` here would answer for a bucket nobody asked to migrate.
  */
  const noConditionals = memoryStore({ ".audit/a.json": "legacy" });
  noConditionals.capabilities = {
    conditionalCreate: false,
    conditionalWrite: false,
    conditionalDelete: false,
  };
  const refusedButRead = await readStorageLayoutState(noConditionals);
  check(
    "capabilities do not change what the state file says",
    refusedButRead.observed === true && refusedButRead.state === null,
  );

  /*
    Hand-edited or half-written state is not an answer, and must not become
    "never run" — that records a false absence and puts the offer back on a
    context that has already been migrated. `migrateStorageLayout` throws on
    this shape; this one declines to have learned anything.
  */
  const corrupt = memoryStore({
    [STORAGE_LAYOUT_MIGRATION_KEY]: '{"prefixIndex":-1}',
  });
  const unusable = await readStorageLayoutState(corrupt);
  check(
    "state of an unsupported shape is not read as never-run",
    unusable.observed === false && unusable.state === null,
  );

  const unreadable = memoryStore();
  unreadable.get = async () => {
    throw new Error("bucket said no");
  };
  const silent = await readStorageLayoutState(unreadable);
  check(
    "a bucket that will not answer teaches us nothing, rather than lying",
    silent.observed === false && silent.state === null,
  );
}
