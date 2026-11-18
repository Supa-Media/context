/**
 * Adds the words an event refers to, so the agent has them without a lookup of
 * its own: the text a reaction targets, the text an inline reply quotes, and
 * the text an edit replaced, a poll's title and options for a vote, and a
 * group's name. iMessage puts a group's name on a message only when the
 * message renames it (`groupTitle`), so an ordinary group message carries
 * none: the name is the chat's `displayName` (`chats.get`), kept a few
 * minutes per chat and dropped when the group is renamed.
 *
 * Text comes from a bounded LRU of recent messages (filled by received events
 * and by our own sends), and from messages.get on a miss. A lookup that fails
 * or runs past its timeout leaves the field out; it never holds up the event.
 */

export const LOOKUP_TIMEOUT_MS = 1500;
export const CACHE_SIZE = 2000;
export const CHAT_NAME_TTL_MS = 10 * 60_000;

export function createLru(limit = CACHE_SIZE) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      if (map.size > limit) map.delete(map.keys().next().value);
    },
    get size() {
      return map.size;
    },
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * `lookup(guid)` resolves to {text, fromMe} or rejects. The cache may be shared
 * between lines: message guids are unique across them.
 */
export function createEnricher({ lookup, poll, chat, cache = createLru(), names = createLru(500), timeoutMs = LOOKUP_TIMEOUT_MS, now = Date.now }) {
  /** A group's name (`chats.get` displayName), "" for an unnamed group, or undefined when it cannot be read. */
  async function chatNameOf(guid) {
    if (typeof chat !== "function" || typeof guid !== "string" || !guid.includes(";+;")) return undefined;
    const kept = names.get(guid);
    if (kept && now() - kept.at < CHAT_NAME_TTL_MS) return kept.name;
    try {
      const found = await withTimeout(Promise.resolve().then(() => chat(guid)), timeoutMs);
      if (found && typeof found.displayName === "string") {
        names.set(guid, { name: found.displayName, at: now() });
        return found.displayName;
      }
    } catch {
      // Best effort: the event goes out without the name, and the next message asks again.
    }
    return kept?.name;
  }

  /** A poll's title and options (`polls.get`), or undefined when there is no lookup or it fails. */
  async function pollOf(guid) {
    if (typeof poll !== "function" || typeof guid !== "string") return undefined;
    try {
      const found = await withTimeout(Promise.resolve().then(() => poll(guid)), timeoutMs);
      if (!found || !Array.isArray(found.options)) return undefined;
      return {
        title: typeof found.title === "string" ? found.title : "",
        options: found.options.map((option) => ({ id: option.optionIdentifier, text: option.text })),
      };
    } catch {
      return undefined;
    }
  }

  function remember(guid, text, fromMe) {
    if (typeof guid !== "string" || typeof text !== "string") return;
    cache.set(guid, { text, fromMe: fromMe === true });
  }

  async function resolve(guid) {
    const hit = cache.get(guid);
    if (hit) return hit;
    try {
      const found = await withTimeout(Promise.resolve().then(() => lookup(guid)), timeoutMs);
      if (found && typeof found.text === "string") {
        cache.set(guid, { text: found.text, fromMe: found.fromMe === true });
        return cache.get(guid);
      }
    } catch {
      // The lookup is best effort; the event goes out without the words.
    }
    return undefined;
  }

  /** The extra fields for one raw event, as map.mjs reads them. */
  async function enrich(event) {
    const extras = {};
    switch (event?.type) {
      case "message.received": {
        const message = event.message;
        if (!message || typeof message.guid !== "string") break;
        remember(message.guid, message.content?.text ?? "", message.isFromMe);
        if (!message.groupTitle) {
          const name = await chatNameOf(event.chatGuid ?? message.chatGuids?.[0]);
          if (name) extras.chatName = name;
        }
        if (message.replyTargetGuid) {
          const target = await resolve(message.replyTargetGuid);
          if (target) {
            extras.replyToText = target.text;
            extras.replyToFromMe = target.fromMe;
          }
        }
        break;
      }
      case "message.edited": {
        const previous = cache.get(event.messageGuid);
        if (previous) extras.previousText = previous.text;
        remember(event.messageGuid, event.content?.text ?? "", event.isFromMe);
        break;
      }
      case "group.changed": {
        // A rename keeps the new name; any other change means the kept one may be old, so the next message reads it again.
        if (typeof event.chatGuid !== "string") break;
        const renamed = event.change?.type === "displayNameChanged" && typeof event.change.displayName === "string";
        names.set(event.chatGuid, renamed ? { name: event.change.displayName, at: now() } : { name: "", at: -Infinity });
        break;
      }
      case "poll.changed": {
        const found = await pollOf(event.pollMessageGuid);
        if (found) extras.poll = found;
        break;
      }
      case "message.stickerPlaced":
      case "message.reactionAdded":
      case "message.reactionRemoved": {
        const target = await resolve(event.messageGuid);
        if (target) {
          extras.targetText = target.text;
          extras.targetFromMe = target.fromMe;
        }
        break;
      }
      default:
        break;
    }
    return extras;
  }

  return { enrich, remember, resolve };
}
