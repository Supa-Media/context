/**
 * Bots' logos for every surface that draws one (the Areas list, a bot's panel, Agent Mail), held for the session the
 * way `faceStore.ts` holds people's faces, so a logo drawn once is drawn again at once, on the first frame, with no
 * robot in between (Dev2, 2026-11-26: "it takes some time for the bot image to load up, can we have it be instant?
 * like the person images?").
 *
 * - **A logo** is read through its card (`readNoteImage`, the card is its gate). The key is the stored picture's
 *   name, a hash of its bytes, so a kept logo never goes stale. A failed read is asked again next time.
 * - **This device's copy** (`kept`, the phone and desktop apps only, `deviceFirst`) is drawn while the server is
 *   asked, as a note is; the server's answer then stands, a refusal included.
 * - **A card's `avatar:`** is remembered by card path once any surface has read it, so Agent Mail can draw a bot the
 *   Areas page already read without reading its card first.
 *
 * Imports nothing from React, so a test can drive it.
 */

/** A bot's logo: `key` names the bytes, `read` asks the server for them as a `src`, `kept` this device's copy. */
export interface FacePicture {
  readonly key: string;
  readonly read: () => Promise<string | null>;
  readonly kept?: () => Promise<string | null>;
}

const shown = new Map<string, string>();
const reading = new Map<string, Promise<string | null>>();

/** The logo already read this session, for a first frame that draws it at once. */
export function shownPicture(key: string): string | undefined {
  return shown.get(key);
}

/** Ask the server once a session for every face drawing this logo. */
export function readPicture(picture: FacePicture): Promise<string | null> {
  let found = reading.get(picture.key);
  if (found === undefined) {
    found = picture.read().catch(() => null);
    reading.set(picture.key, found);
    void found.then((src) => {
      if (src === null) reading.delete(picture.key);
      else shown.set(picture.key, src);
    });
  }
  return found;
}

const avatars = new Map<string, string>();
const avatarReads = new Map<string, Promise<string>>();

/** The `avatar:` leaf a card named when last read this session ("" for none), or undefined if not read yet. */
export function knownAvatar(cardKey: string): string | undefined {
  return avatars.get(cardKey);
}

/** Remember what a card names, from any surface that read it. */
export function noteAvatar(cardKey: string, leaf: string): void {
  avatars.set(cardKey, leaf);
}

/** Read a card's `avatar:` once for every surface asking at the same time; "" when it names none or can't be read. */
export function readAvatar(cardKey: string, read: () => Promise<string>): Promise<string> {
  let found = avatarReads.get(cardKey);
  if (found === undefined) {
    found = read()
      .then((leaf) => {
        avatars.set(cardKey, leaf);
        return leaf;
      })
      .catch(() => "")
      .finally(() => avatarReads.delete(cardKey));
    avatarReads.set(cardKey, found);
  }
  return found;
}

/** Forget everything, for a test. */
export function resetBotPictures(): void {
  shown.clear();
  reading.clear();
  avatars.clear();
  avatarReads.clear();
}
