import {
  ChatContributionConflictError,
  ChatContributionIncompleteError,
  loadActiveChatContributions,
  persistChatContribution,
} from "../src/communications/googleChat/contributionStore.js";

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
    async delete(path) {
      objects.delete(path);
    },
  };
}

const day = (date, body) => ({ date, events: [{ id: body, body }], unavailableSpaces: [] });
const contribution = (account, days) => ({ account, destinationFolder: "0-inbox/google-chat", days });

export async function runChatContributionStoreChecks(check) {
  const store = memoryStore();
  await persistChatContribution({ store, sourceId: "connection-a", contribution: contribution("a@example.com", [day("2026-09-10", "a-old")]) });
  await persistChatContribution({ store, sourceId: "connection-b", contribution: contribution("b@example.com", [day("2026-09-10", "b")]) });
  await persistChatContribution({ store, sourceId: "connection-a", contribution: contribution("a@example.com", [day("2026-09-11", "a-new")]) });

  const loaded = await loadActiveChatContributions({ store, sourceIds: ["connection-a", "connection-b"] });
  check("persisted Chat contributions include every active account", loaded.length === 2);
  check("a later account pass preserves that account's older days", loaded[0].days.map(({ date }) => date).join("|") === "2026-09-10|2026-09-11");
  check("updating one account cannot erase its sibling contribution", loaded[1].days[0]?.events[0]?.body === "b");
  check("Chat contribution bytes live only under hidden customer-bucket plumbing", [...store.objects.keys()].every((path) => path.startsWith(".context/communications/google-chat/contributions/")));

  let incomplete = false;
  try {
    await loadActiveChatContributions({ store, sourceIds: ["connection-a", "connection-never-synced"] });
  } catch (error) {
    incomplete = error instanceof ChatContributionIncompleteError;
  }
  check("a missing active account fails closed before shared notes can erase it", incomplete);

  let invalidDate = false;
  try {
    await persistChatContribution({ store, sourceId: "invalid-date", contribution: contribution("date@example.com", [day("2026-02-30", "impossible")]) });
  } catch (error) {
    invalidDate = error instanceof TypeError;
  }
  check("a calendar date that does not exist never becomes a contribution key", invalidDate);

  let rebound = false;
  try {
    await persistChatContribution({ store, sourceId: "connection-a", contribution: contribution("intruder@example.com", [day("2026-09-12", "wrong-account")]) });
  } catch (error) {
    rebound = error instanceof ChatContributionConflictError;
  }
  check("a source cannot be silently rebound to a different Google account", rebound);

  const conflictStore = memoryStore();
  const originalGet = conflictStore.get;
  let raced = false;
  conflictStore.get = async (path) => {
    const result = await originalGet(path);
    if (!raced && path.endsWith("manifest.json")) {
      raced = true;
      await conflictStore.put(path, JSON.stringify({ sourceId: "other" }));
    }
    return result;
  };
  let conflicted = false;
  try {
    await persistChatContribution({ store: conflictStore, sourceId: "connection-a", contribution: contribution("a@example.com", [day("2026-09-10", "a")]) });
  } catch (error) {
    conflicted = error instanceof ChatContributionConflictError;
  }
  check("a concurrent contribution change is refused instead of last-writer-wins", conflicted);

  let unsafeBackend = false;
  try {
    await persistChatContribution({
      store: { ...memoryStore(), capabilities: { conditionalWrite: false } },
      sourceId: "connection-a",
      contribution: contribution("a@example.com", [day("2026-09-10", "a")]),
    });
  } catch (error) {
    unsafeBackend = error instanceof TypeError;
  }
  check("shared Chat sync refuses a backend that cannot enforce conditional writes", unsafeBackend);
}
