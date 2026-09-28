/**
 * A projects folder held in memory, for `ProjectsFixture` alone: the notes a
 * folder page reads (`FolderListSource`), the creates, moves and removes a
 * project's List makes (`TaskHost.io`), and one note's words for the side
 * peek. Every write lands here, so a drop, a move into Backlog and its Undo
 * can be watched in a real browser. Fake names and paths only; nothing here
 * reaches a bucket.
 */

import { setNoteProperty } from "../../../../mcp/src/lists.js";
import type { FolderListSource, ListNote, PropertyValue } from "../../console/files/listBlock/model";
import { noteFromText } from "../../console/files/folderPage/tasks/pendingNotes";
import { entriesIn } from "../../console/files/folderPage/model";
import type { FileEntry, FolderListing } from "../../console/files/types";
import { baseName } from "../../console/files/paths";

export const PROJECTS = "1-projects";

type Value = string | readonly string[] | null;

function frontmatter(properties: Record<string, Value>): string {
  const lines = Object.entries(properties)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => (Array.isArray(value) ? `${key}:\n${value.map((each) => `  - ${each}`).join("\n")}` : `${key}: ${value as string}`));
  return lines.length === 0 ? "" : `---\n${lines.join("\n")}\n---\n`;
}

function note(title: string, properties: Record<string, Value>, words: string): string {
  return `${frontmatter(properties)}# ${title}\n\n${words}\n`;
}

/** The folder as a busy workspace has it: long names, tags, owners, progress, a parked pair and a plain note. */
function seed(): Map<string, string> {
  const files: [string, string][] = [
    [`${PROJECTS}/togather/overview.md`, note("Togather: first 1,000 active members", { status: "in progress", priority: "p1", owner: "@seyi", tags: ["togather"] }, "Grow the community app to a thousand people who come back every week.")],
    [`${PROJECTS}/togather/launch-plan.md`, note("Togather early-adopter launch plan, 2026-09-26 to 2026-10-04", { status: "to do" }, "Invite lists, the first event, and who says what.")],
    [`${PROJECTS}/togather/market-size.md`, note("Togather market size", {}, "Notes on the size of the market.")],
    [`${PROJECTS}/portal/overview.md`, note("Portal: the member portal redesign and the payments migration", { status: "in progress", priority: "p0", owner: "@shyoh", tags: ["portal"], due: "2026-10-02" }, "One place for members to pay, book and read.")],
    [`${PROJECTS}/software/overview.md`, note("Software rebuild of the booking engine", { status: "in progress", owner: "@seyi" }, "Rewrite the booking engine so a week of bookings loads in a second.")],
    ...Array.from({ length: 10 }, (_, at): [string, string] => [`${PROJECTS}/software/step-${at + 1}.md`, note(`Booking engine step ${at + 1}`, { status: at < 3 ? "finished" : "to do" }, "One step of the rebuild.")]),
    [`${PROJECTS}/context-search/overview.md`, note("Context search that answers in one second on a phone", { status: "in progress", priority: "p2", owner: "@seyi", tags: ["context"] }, "Search every note on the device before the bucket answers.")],
    ...[1, 2, 3, 4].map((at): [string, string] => [`${PROJECTS}/context-search/part-${at}.md`, note(`Search part ${at}`, { status: "to do" }, "A part of search.")]),
    [`${PROJECTS}/context-sharing/overview.md`, note("Context sharing links for one folder", { status: "in progress", priority: "p3", owner: "@seyi", tags: ["context", "sharing"] }, "A link an owner mints and can revoke.")],
    ...[1, 2, 3].map((at): [string, string] => [`${PROJECTS}/context-sharing/part-${at}.md`, note(`Sharing part ${at}`, { status: at === 1 ? "finished" : "to do" }, "A part of sharing.")]),
    [`${PROJECTS}/cafe/overview.md`, note("Café opening", { status: "to do", owner: "@sayo", tags: ["cafe"], due: "2026-11-14" }, "Open a café on the corner by spring.")],
    [`${PROJECTS}/winter-retreat.md`, note("Winter retreat", { status: "finished", owner: "@sayo" }, "Done in January.")],
    [`${PROJECTS}/reading-list.md`, note("Reading list for the team", {}, "Books worth a look.")],
    [`${PROJECTS}/backlog/overview.md`, note("Backlog", {}, "Projects parked for later.")],
    [`${PROJECTS}/backlog/podcast/overview.md`, note("A podcast about building in public", { status: "to do", owner: "@seyi", tags: ["media"] }, "Twelve episodes, one a fortnight.")],
    [`${PROJECTS}/backlog/offline-maps.md`, note("Offline maps for the field team", { status: "to do" }, "Maps that work with no signal.")],
  ];
  return new Map(files);
}

const entry = (kind: "file" | "folder", path: string): FileEntry => ({
  kind,
  path,
  name: baseName(path),
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
});

export interface ProjectsStore {
  readonly source: FolderListSource;
  listing(folder: string): FolderListing;
  text(path: string): string | null;
  write(path: string, text: string): void;
  create(path: string, text: string): void;
  move(from: string, to: string): void;
  remove(path: string): void;
  subscribe(listener: () => void): () => void;
}

export function projectsStore(options: { canWrite: boolean }): ProjectsStore {
  const files = seed();
  const times = new Map<string, number>();
  let clock = Date.now() - 60 * 60_000;
  for (const path of files.keys()) times.set(path, (clock += 60_000));
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const notes = (): ListNote[] => [...files].map(([path, text]) => noteFromText(path, text, times.get(path) ?? 0));
  const touch = (path: string) => times.set(path, Date.now());
  const setProperties = async (path: string, changes: readonly (readonly [string, Value])[], opts?: { create?: boolean }) => {
    let text = files.get(path) ?? (opts?.create === true ? "" : null);
    if (text === null) return "That note isn’t here any more.";
    for (const [key, value] of changes) {
      const next = setNoteProperty(text, key, value as PropertyValue | null) as { text: string } | { error: string };
      if ("error" in next) return next.error;
      text = next.text;
    }
    files.set(path, text);
    touch(path);
    changed();
    return null;
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const source: FolderListSource = {
    load: async (folder) => ({ notes: notes().filter((each) => folder === "" || each.path.startsWith(`${folder}/`)), complete: true }),
    subscribe,
    readBody: async (path) => {
      const text = files.get(path);
      return text === undefined ? null : { text, encrypted: false };
    },
    searchOwners: async () => ({
      people: [
        { value: "@seyi", name: "Seyi", isMe: true },
        { value: "@sayo", name: "Sayo", isMe: false },
        { value: "@shyoh", name: "Shyoh", isMe: false },
      ],
      agents: ["Claude"],
      truncated: false,
    }),
    ...(options.canWrite
      ? {
          setProperty: (path: string, key: string, value: string | null, opts?: { create?: boolean }) => setProperties(path, [[key, value]], opts),
          setProperties,
        }
      : {}),
  };
  return {
    source,
    listing: (folder) => ({
      path: folder,
      folderDefault: "team",
      entries: entriesIn(folder, notes()).map((each) => entry(each.kind, each.path)),
      truncated: false,
      manifestUsable: true,
    }),
    text: (path) => files.get(path) ?? null,
    write: (path, text) => {
      files.set(path, text);
      touch(path);
      changed();
    },
    create: (path, text) => {
      if (files.has(path)) throw new Error("Something is already there.");
      files.set(path, text);
      touch(path);
      changed();
    },
    move: (from, to) => {
      for (const [path, text] of [...files]) {
        if (path !== from && !path.startsWith(`${from}/`)) continue;
        const next = `${to}${path.slice(from.length)}`;
        files.delete(path);
        files.set(next, text);
        times.set(next, times.get(path) ?? Date.now());
      }
      changed();
    },
    remove: (path) => {
      for (const each of [...files.keys()]) if (each === path || each.startsWith(`${path}/`)) files.delete(each);
      changed();
    },
    subscribe,
  };
}
