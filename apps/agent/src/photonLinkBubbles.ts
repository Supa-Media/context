/**
 * Tex's words with a link go out on Photon as two bubbles: the words, then the link alone with its preview
 * (`photonLine.ts` `sendPhotonWords`). The send is noted by the words' guid, so the link bubble's own reports (Apple's
 * echo, a read, a delivery check 30s and 3 min later) named a guid no send had and were always unmatched (2026-11-17).
 *
 * The mapping is kept in the chat object's storage, which is where those reports are answered (`sendblueStatus.ts`).
 * An in-memory map died with the isolate, so a report after the object was evicted logged `unmatched`. Noting never
 * fails the send: the words have already gone.
 */

/** What of a chat object's storage this needs, so tests can pass a Map. */
export type LinkBubbleStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};

/** Handed to the line that sends, so it can note a bubble without knowing the storage. */
export type LinkNotes = {
  note(link: string | undefined, words: string | undefined): Promise<void>;
};

const KEY = "plink";
const MAX_KEPT = 300;
const GUID = /^[A-Za-z0-9_.:@+-]{1,128}$/;

type Row = { link: string; words: string };

function guid(value: string | undefined): value is string {
  return typeof value === "string" && GUID.test(value);
}

/** Notes that `link` is the link bubble of the words sent as `words`. */
export async function noteLinkBubble(storage: LinkBubbleStorage, link: string | undefined, words: string | undefined): Promise<void> {
  if (!guid(link) || !guid(words) || link === words) return;
  const kept = ((await storage.get<Row[]>(KEY)) ?? []).filter((row) => guid(row?.link) && guid(row?.words) && row.link !== link);
  kept.push({ link, words });
  await storage.put(KEY, kept.slice(-MAX_KEPT));
}

/** The words' guid a link bubble belongs to, or undefined for any other guid. */
export async function linkBubbleWords(storage: LinkBubbleStorage, id: string): Promise<string | undefined> {
  if (!guid(id)) return undefined;
  const kept = (await storage.get<Row[]>(KEY)) ?? [];
  return kept.find((row) => row?.link === id)?.words;
}

/** The line's `linkNotes` for a chat object that has the storage itself. */
export function linkNotesOf(storage: LinkBubbleStorage): LinkNotes {
  return { note: (link, words) => noteLinkBubble(storage, link, words) };
}

/**
 * The line's `linkNotes` when the send runs outside the chat object (the gateway's remote line): the mapping is
 * posted to the object its reports go to. A non-2xx throws; the send catches it.
 */
export function remoteLinkNotes(inbox: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }): LinkNotes {
  return {
    note: async (link, words) => {
      if (!guid(link) || !guid(words) || link === words) return;
      const response = await inbox.fetch("https://inbox/link-bubble", { method: "POST", body: JSON.stringify({ link, words }) });
      if (!response.ok) throw new Error("link bubble not noted");
    },
  };
}

/** `POST /link-bubble`: keep one mapping. False when the body is not two guids. */
export async function keepLinkBubble(storage: LinkBubbleStorage, body: unknown): Promise<boolean> {
  if (body === null || typeof body !== "object") return false;
  const { link, words } = body as { link?: unknown; words?: unknown };
  if (typeof link !== "string" || typeof words !== "string") return false;
  await noteLinkBubble(storage, link, words);
  return guid(link) && guid(words) && link !== words;
}
