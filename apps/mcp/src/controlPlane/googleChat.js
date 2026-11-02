/**
 * A Google Chat message a person's AI sends as them (`tools/googleChat.js`):
 * the control plane checks the limits, picks the connection (one of the
 * token's person's own that granted Chat sending), finds the direct message
 * or space by the name Chat gives it, and sends. `check` asks only whether it
 * could go and where, and sends nothing. `spaces` lists the spaces they are in.
 * `recent` reads the messages written to them since a moment, for check-ins
 * (`agent/checkInSources.js`). `conversation` reads one conversation the
 * person named, a space by its id or the direct message with one person
 * (`tools/googleChatRead.js`), through the same address.
 *
 * Answers `{ ok: true, from, place }` / `{ ok: true, from, spaces }`, or `{ ok: false, refused }`.
 */

const REFUSALS = new Set([
  "invalid",
  "not_allowed",
  "no_chat",
  "ai_access_needed",
  "hourly_limit",
  "daily_limit",
  "space_not_found",
  "ambiguous",
  "person_not_found",
  "chat_not_enabled",
  "reconnect_required",
  "unavailable",
  "unconfirmed",
]);

const SPACE_ID = /^spaces\/[A-Za-z0-9_-]{1,64}$/;

/** Finding a direct message, then starting one and sending, is several Google calls. */
const TIMEOUT_MS = 25_000;

function refusedOf(answer) {
  return { ok: false, refused: REFUSALS.has(answer?.refused) ? answer.refused : "unavailable" };
}

function placeOf(place) {
  if (typeof place?.person === "string") return { person: place.person };
  if (typeof place?.space === "string") return { space: place.space };
  return null;
}

export function createGoogleChatMethods({ post }) {
  return {
    async sendGoogleChat(accessToken, expectedWorkspaceId, message, { check = false } = {}) {
      const answer = await post("/gateway/chat/send", { accessToken, expectedWorkspaceId, message, check }, { timeoutMs: TIMEOUT_MS });
      const place = placeOf(answer?.place);
      if (answer?.ok !== true || typeof answer.from !== "string" || place === null) return refusedOf(answer);
      if (check) return { ok: true, from: answer.from, place };
      // A send is sent only with the ids Google gave the message and its conversation.
      const space = typeof answer.space === "string" && SPACE_ID.test(answer.space) ? answer.space : null;
      const made = space !== null && typeof answer.message === "string" && answer.message.startsWith(`${space}/messages/`) ? answer.message : null;
      if (made === null) return { ok: false, refused: "unconfirmed" };
      return { ok: true, from: answer.from, place, space, message: made, setupUsed: answer.setupUsed === true };
    },
    async googleChatSpaces(accessToken, expectedWorkspaceId) {
      const answer = await post("/gateway/chat/spaces", { accessToken, expectedWorkspaceId }, { timeoutMs: TIMEOUT_MS });
      if (answer?.ok === true && Array.isArray(answer.spaces)) {
        const spaces = answer.spaces.filter((space) => typeof space?.name === "string" && typeof space?.displayName === "string");
        return { ok: true, from: typeof answer.from === "string" ? answer.from : "", spaces };
      }
      return refusedOf(answer);
    },
    async googleChatRecent(accessToken, expectedWorkspaceId, { since }) {
      const answer = await post("/gateway/chat/recent", { accessToken, expectedWorkspaceId, since }, { timeoutMs: TIMEOUT_MS });
      if (answer?.ok === true && Array.isArray(answer.messages)) {
        const messages = answer.messages.filter(
          (message) => typeof message?.id === "string" && typeof message?.text === "string" && typeof message?.at === "string",
        );
        return { ok: true, messages };
      }
      return refusedOf(answer);
    },
    async googleChatConversation(accessToken, expectedWorkspaceId, { space, to, limit }) {
      const answer = await post("/gateway/chat/recent", { accessToken, expectedWorkspaceId, space, to, limit }, { timeoutMs: TIMEOUT_MS });
      const place = placeOf(answer?.place);
      if (answer?.ok === true && Array.isArray(answer.messages) && place !== null) {
        const messages = answer.messages.filter(
          (message) =>
            typeof message?.id === "string" && typeof message?.from === "string" && typeof message?.text === "string" && typeof message?.at === "string",
        );
        return { ok: true, from: typeof answer.from === "string" ? answer.from : "", place, messages };
      }
      return refusedOf(answer);
    },
  };
}
