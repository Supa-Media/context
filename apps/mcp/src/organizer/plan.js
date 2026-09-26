/**
 * Auto-organize: which notes a sweep looks at, decided from the listing alone.
 *
 * The sweep is two trips through the file barrier with Jev in between (see
 * docs/decisions/storage-and-credentials/inference.md). This module is the
 * first half's planning: given every visible note's path and last save, which
 * projects and which inbox notes are worth a question, and where an inbox note
 * could go. Nothing here reads a body, so nothing here can leak one.
 *
 * Folders are recognised by shape, the way `archiveRoots` recognises an
 * archive: `1-projects`, `projects` and `2-Projects` all say "projects". A
 * context with no such folder simply gets no suggestions of that kind; this
 * never invents a destination in somebody's bucket.
 */

import { FRONT_NOTES } from "../lists/grammar.js";

const ROOT_PATTERNS = {
  inbox: /^(?:\d+-)?inbox$/i,
  projects: /^(?:\d+-)?projects$/i,
  areas: /^(?:\d+-)?areas$/i,
  resources: /^(?:\d+-)?resources$/i,
  archive: /^(?:\d+-)?archive$/i,
};

/** Per sweep, so one sweep's inference bill is bounded before it starts. */
export const MAX_SWEEP_PROJECTS = 60;
export const MAX_SWEEP_INBOX = 40;
/** Jev's choice question takes 64 options; one of them is "leave it". */
export const MAX_DESTINATIONS = 63;

function isPlumbing(path) {
  return path.split("/").some((segment) => segment.startsWith("."));
}

/** The first top-level folder of each kind this context has, or null. */
export function organizerRoots(paths) {
  const tops = new Set();
  for (const path of paths) {
    const slash = path.indexOf("/");
    if (slash > 0) tops.add(path.slice(0, slash));
  }
  const sorted = [...tops].sort();
  const roots = {};
  for (const [kind, pattern] of Object.entries(ROOT_PATTERNS)) {
    roots[kind] = sorted.find((top) => pattern.test(top)) ?? null;
  }
  return roots;
}

function humanize(segment) {
  const words = segment.replace(/\.md$/i, "").replace(/^\d+-/, "").replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : segment;
}

/**
 * The plan: projects to ask about, inbox notes to ask about, and the folders
 * an inbox note may be filed into.
 *
 * `entries` are `{ path, updatedAt?, etag? }` for every note the owner can see.
 * A project is a note directly in the projects folder, or a folder there with a
 * front note; which of those actually has a `status` is only known once the
 * front notes are read, so every candidate is returned and the caller drops the
 * ones without one.
 */
export function planSweep(entries, now) {
  const notes = entries.filter((entry) => entry.path.endsWith(".md") && !isPlumbing(entry.path));
  const roots = organizerRoots(notes.map((entry) => entry.path));
  const projects = [];
  const inbox = [];
  const destinations = [];

  if (roots.projects) {
    const base = `${roots.projects}/`;
    const folders = new Map();
    for (const entry of notes) {
      if (!entry.path.startsWith(base)) continue;
      const rest = entry.path.slice(base.length).split("/");
      if (rest.length === 1) {
        projects.push({ kind: "note", path: entry.path, frontPath: entry.path, title: humanize(rest[0]), updatedAt: entry.updatedAt ?? null, etag: entry.etag ?? null });
        continue;
      }
      const folder = `${base}${rest[0]}`;
      const known = folders.get(folder) ?? { files: [], updatedAt: null };
      known.files.push(entry);
      if (typeof entry.updatedAt === "number") known.updatedAt = Math.max(known.updatedAt ?? 0, entry.updatedAt);
      folders.set(folder, known);
    }
    for (const [folder, known] of folders) {
      const front = FRONT_NOTES.map((name) => known.files.find((file) => file.path === `${folder}/${name}`)).find(Boolean);
      if (!front) continue;
      const title = humanize(folder.split("/").pop());
      projects.push({ kind: "folder", path: folder, frontPath: front.path, title, updatedAt: known.updatedAt, etag: front.etag ?? null });
      destinations.push({ path: folder, title, group: "projects" });
    }
  }

  for (const kind of ["areas", "resources"]) {
    const root = roots[kind];
    if (!root) continue;
    const seen = new Set();
    for (const entry of notes) {
      if (!entry.path.startsWith(`${root}/`)) continue;
      const rest = entry.path.slice(root.length + 1).split("/");
      if (rest.length < 2 || seen.has(rest[0])) continue;
      seen.add(rest[0]);
      destinations.push({ path: `${root}/${rest[0]}`, title: humanize(rest[0]), group: kind });
    }
  }

  if (roots.inbox) {
    const base = `${roots.inbox}/`;
    for (const entry of notes) {
      if (!entry.path.startsWith(base)) continue;
      const rest = entry.path.slice(base.length).split("/");
      const direct = rest.length === 1;
      const meeting = rest.length === 2 && rest[0] === "meetings";
      // Loose notes and meetings only. Everything deeper is a channel (mail,
      // chat, contacts, saved sessions) that has its own place already.
      if (!direct && !meeting) continue;
      inbox.push({ path: entry.path, title: humanize(rest[rest.length - 1]), updatedAt: entry.updatedAt ?? null, etag: entry.etag ?? null, meeting });
    }
  }

  const newestFirst = (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.path.localeCompare(b.path);
  projects.sort(newestFirst);
  inbox.sort(newestFirst);
  destinations.sort((a, b) => ["projects", "areas", "resources"].indexOf(a.group) - ["projects", "areas", "resources"].indexOf(b.group) || a.path.localeCompare(b.path));

  return {
    roots,
    now,
    projects: projects.slice(0, MAX_SWEEP_PROJECTS),
    inbox: inbox.slice(0, MAX_SWEEP_INBOX),
    destinations: destinations.slice(0, MAX_DESTINATIONS),
  };
}
