/**
 * AN IN-APP TEST CHAT (Dev2, 2026-11-27: "we need a separate column for in-app, so we have 1:1 group and in app tests").
 *
 * The Lab's test chats are a 1:1, a group, or the person's own chat with Tex in the Context app. An in-app one is their
 * app chat as the gateway names it (`packages/tex/worker/appChat.ts`): `app:<their user id>`, so its texts reach the
 * chat object as the app's route hands them over and run as app turns (`chatRun.js`), and what a test text says the
 * app had open (`row.screen`, `packages/lab/src/texScreen.cjs`) is read by the turn as the app's saved copy.
 */

/** An app chat's id starts so (`appChat.ts` `APP_CHAT_PREFIX`). */
export const APP_PREFIX = "app:";
/** A user id an app chat may name (`appChat.ts` `APP_USER`): any other names nobody, and the turn would never run. */
const APP_USER = /^[a-z0-9]{16,64}$/;

/** The app chat an in-app test chat is, for the session it runs as: `app:<user id>`, or null when it is no app chat. */
export function appChatIdOf(about, payload) {
  const user = payload?.actorUserId;
  return about?.kind === "app" && typeof user === "string" && APP_USER.test(user) ? `${APP_PREFIX}${user}` : null;
}

/**
 * What an in-app test text says the app had open (`row.screen`, `texSets.cjs` `screenProblems`), served as the app chat's
 * object serves its saved copy (`texChat/appSeen.js`, `GET /app/seen`), so the turn's `readScreen` finds it fresh. Only
 * that one object and that one read answer; nothing is saved, and no other object is reached.
 */
export function appScreenChat(chatId, screen, now = Date.now) {
  const name = `chat:${chatId}`;
  return Object.freeze({
    idFromName: (wanted) => ({ wanted, toString: () => wanted }),
    get: (id) => ({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (id?.wanted !== name || request.method !== "GET" || new URL(request.url).pathname !== "/app/seen" || screen === null || screen === undefined) return Response.json({ error: "not_in_lab" }, { status: 404 });
        return Response.json({ inbox: chatId, ...screen, at: now() });
      },
    }),
  });
}

