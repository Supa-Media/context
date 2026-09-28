import { dataUrlFor } from "../files/imageBytes";

/**
 * Whose face is what, for every surface that draws a person.
 *
 * Initials are gone (Dev2, 2026-09-28): a person is drawn with a photo they
 * uploaded, else their personal workspace's icon, else a silhouette. The
 * server decides the first two (`functions/faces.ts`); this holds the answer
 * for the session, keyed by `@handle`, because a handle is how every surface
 * names a person — owner lines, presence, comment authors, agents' owners.
 *
 * **Imports nothing from React, React Native or Convex**, for the reason
 * `useWorkspaceIcons` gives and one more: the editor's comment cards and
 * typing flags are plain DOM (`comments/dom.ts`, `presence/remoteCarets.ts`)
 * and are compiled into the phone's editor bundle, which must not grow a UI
 * framework. A surface with no backend (the homepage, the demo console) never
 * fills this, and draws silhouettes.
 */

/** What a face draws once resolved. `undefined` from `faceFor` is a silhouette. */
export type ShownFace = { kind: "photo"; uri: string } | { kind: "emoji"; emoji: string };

/** One person as the server describes them (`faces.myPeople`). */
export interface ServerPerson {
  person: string;
  handle: string;
  face:
    | { kind: "photo"; url: string }
    | { kind: "emoji"; emoji: string }
    | { kind: "workspacePhoto"; leaf: string }
    | { kind: "none" };
}

type ReadWorkspacePhoto = (person: string) => Promise<{ bytes: ArrayBuffer; contentType: string }>;

let people = new Map<string, ServerPerson>();
let mine: { person: string; face: ServerPerson["face"]; uploaded?: boolean } | null = null;

/**
 * Workspace icon photos already fetched, keyed by person and leaf. The leaf is
 * a content hash, so a new photo is a new key and an entry is never stale.
 */
const photos = new Map<string, string>();
const pending = new Set<string>();
/** Asked for and not got: one failed request, not one per render. */
const missing = new Set<string>();

let version = 0;
const listeners = new Set<() => void>();

function announce(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeFaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function facesVersion(): number {
  return version;
}

const keyOf = (handle: string) => handle.toLowerCase();

/**
 * Take the server's answer, and fetch any workspace photo it names that this
 * session has not got. Safe to call on every change of the query.
 */
export function setFaces(
  answer: {
    me: { person: string; face: ServerPerson["face"]; uploaded?: boolean } | null;
    people: readonly ServerPerson[];
  },
  readWorkspacePhoto: ReadWorkspacePhoto,
): void {
  people = new Map(answer.people.map((row) => [keyOf(row.handle), row]));
  mine = answer.me ?? null;
  for (const row of answer.people) {
    if (row.face.kind !== "workspacePhoto") continue;
    const key = `${row.person}|${row.face.leaf}`;
    if (photos.has(key) || pending.has(key) || missing.has(key)) continue;
    pending.add(key);
    void readWorkspacePhoto(row.person)
      .then((result) => {
        photos.set(key, dataUrlFor(result.bytes, result.contentType));
      })
      .catch(() => {
        // A bucket that is down or a photo removed: the silhouette, quietly.
        missing.add(key);
      })
      .finally(() => {
        pending.delete(key);
        announce();
      });
  }
  announce();
}

/** Forget everything, for sign-out. */
export function clearFaces(): void {
  people = new Map();
  mine = null;
  announce();
}

function shown(person: string, face: ServerPerson["face"]): ShownFace | undefined {
  if (face.kind === "photo") return { kind: "photo", uri: face.url };
  if (face.kind === "emoji") return { kind: "emoji", emoji: face.emoji };
  if (face.kind === "workspacePhoto") {
    const uri = photos.get(`${person}|${face.leaf}`);
    return uri === undefined ? undefined : { kind: "photo", uri };
  }
  return undefined;
}

/**
 * The face for a name as surfaces write it: `@seyi`, or `seyi`. Anything that
 * is not a handle someone here holds (an email, a full name, a visitor) draws
 * a silhouette.
 */
export function faceFor(name: string | null | undefined): ShownFace | undefined {
  if (!name) return undefined;
  const trimmed = name.trim();
  const handle = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
  const row = people.get(keyOf(handle));
  return row === undefined ? undefined : shown(row.person, row.face);
}

/** The signed-in person's own face. */
export function myFace(): ShownFace | undefined {
  return mine === null ? undefined : shown(mine.person, mine.face);
}

/** The signed-in person's handle, once faces have loaded. */
export function myHandle(): string | undefined {
  if (mine === null) return undefined;
  for (const row of people.values()) if (row.person === mine.person) return row.handle;
  return undefined;
}

/** Whether the signed-in person's face is a photo they uploaded. */
export function myPhotoUploaded(): boolean {
  return mine?.uploaded === true;
}
