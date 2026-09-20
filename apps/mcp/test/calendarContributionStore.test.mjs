import { mergeEventCaches } from "../../../packages/communications/src/calendar/index.js";
import {
  CalendarContributionConflictError,
  CalendarContributionIncompleteError,
  loadActiveCalendarContributions,
  persistCalendarContribution,
} from "../src/communications/calendarContributionStore.js";

function memoryStore() {
  const objects = new Map();
  let revision = 0;
  return {
    objects,
    async get(path) {
      const object = objects.get(path);
      return object ? { etag: object.etag, text: async () => object.text } : null;
    },
    async put(path, text, options = {}) {
      const existing = objects.get(path);
      if (options.onlyIf?.absent === true && existing) return null;
      if (options.onlyIf?.etagMatches !== undefined && existing?.etag !== options.onlyIf.etagMatches) return null;
      const result = { text, etag: `e${++revision}` };
      objects.set(path, result);
      return { etag: result.etag };
    },
  };
}

function cache(key, date, title) {
  return new Map([[key, { event: { id: key, title }, dates: [date] }]]);
}

function contribution(account, eventCache) {
  return { account, timezone: "America/New_York", destinationFolder: "0-inbox/calendar", eventCache };
}

export async function runCalendarContributionStoreChecks(check) {
  const store = memoryStore();
  await persistCalendarContribution({ store, sourceId: "connection-a", contribution: contribution("a@example.com", cache("a-1", "2026-09-12", "A")) });
  await persistCalendarContribution({ store, sourceId: "connection-b", contribution: contribution("b@example.com", cache("b-1", "2026-09-12", "B")) });

  const loaded = await loadActiveCalendarContributions({ store, sourceIds: ["connection-a", "connection-b"] });
  check("persisted Calendar contributions include every active account", loaded.length === 2);
  check("persisted Calendar caches union without last-account-wins erasure", mergeEventCaches(loaded.map(({ eventCache }) => eventCache)).size === 2);
  check("Calendar contribution bytes live only under hidden customer-bucket plumbing", [...store.objects.keys()].every((path) => path.startsWith(".context/communications/calendar/contributions/")));

  await persistCalendarContribution({ store, sourceId: "connection-a", contribution: contribution("a@example.com", cache("a-2", "2026-09-13", "A2")) });
  const updated = await loadActiveCalendarContributions({ store, sourceIds: ["connection-a", "connection-b"] });
  check("replacing one Calendar account cache preserves its sibling", updated[1].eventCache.has("b-1"));

  let incomplete = false;
  try {
    await loadActiveCalendarContributions({ store, sourceIds: ["connection-a", "never-synced"] });
  } catch (error) {
    incomplete = error instanceof CalendarContributionIncompleteError;
  }
  check("a missing active Calendar account fails closed before shared notes can erase it", incomplete);

  let invalidDate = false;
  try {
    await persistCalendarContribution({ store, sourceId: "invalid-date", contribution: contribution("date@example.com", cache("bad", "2026-02-30", "Impossible")) });
  } catch (error) {
    invalidDate = error instanceof TypeError;
  }
  check("an impossible Calendar cache date is refused", invalidDate);

  let rebound = false;
  try {
    await persistCalendarContribution({ store, sourceId: "connection-a", contribution: contribution("intruder@example.com", cache("a-3", "2026-09-14", "Wrong")) });
  } catch (error) {
    rebound = error instanceof CalendarContributionConflictError;
  }
  check("a Calendar source cannot be silently rebound to another account", rebound);

  const conflictStore = memoryStore();
  const originalGet = conflictStore.get;
  let raced = false;
  conflictStore.get = async (path) => {
    const result = await originalGet(path);
    if (!raced) {
      raced = true;
      await conflictStore.put(path, JSON.stringify({ sourceId: "other" }));
    }
    return result;
  };
  let conflict = false;
  try {
    await persistCalendarContribution({ store: conflictStore, sourceId: "connection-a", contribution: contribution("a@example.com", cache("a-1", "2026-09-12", "A")) });
  } catch (error) {
    conflict = error instanceof CalendarContributionConflictError;
  }
  check("a concurrent Calendar contribution replacement is refused", conflict);

  let unsafeBackend = false;
  try {
    await persistCalendarContribution({
      store: { ...memoryStore(), capabilities: { conditionalWrite: false } },
      sourceId: "connection-a",
      contribution: contribution("a@example.com", cache("a-1", "2026-09-12", "A")),
    });
  } catch (error) {
    unsafeBackend = error instanceof TypeError;
  }
  check("shared Calendar sync refuses a backend that cannot enforce conditional writes", unsafeBackend);
}
