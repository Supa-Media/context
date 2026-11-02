/**
 * The lines of an "about" note — the person's `tex/about.md` (or its old name
 * `tex/about-me.md`) and a group chat's `tex/groups/<id>/about.md` — read the
 * one way both the Tex page (`http/texPage/notes.js`) and the note's writer
 * (`tools/notes/write.js`) read them.
 *
 * Each line may end with a marker naming who it came from and when:
 * `- Prefers short texts (you said so, 2026-11-02)`. The page shows the
 * source and the date beside the line. Tex writes the source (`you said so`,
 * `<name> said so`); the date is added on save by `stampAboutLines`, so it is
 * the day the line was written and never a date a model guessed.
 */

export const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
export const TRAILING = /\s*[(\[]([^()[\]]{1,160})[)\]]\s*$/;

const ABOUT_PATH = /^(?:tex\/about\.md|tex\/about-me\.md|tex\/groups\/[A-Za-z0-9][A-Za-z0-9_-]{0,80}\/about\.md)$/;

/** Whether `path` is an about note: the person's own, or a group chat's. */
export function isAboutNotePath(path) {
  return typeof path === "string" && ABOUT_PATH.test(path) && !path.includes("..");
}

/** A trailing marker's words: a source label and a date, when it carries either. Null otherwise. */
export function markerOf(content) {
  let source = null;
  let at;
  for (const raw of content.split(/[,;·|]/)) {
    const part = raw.trim();
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(part);
    if (date) {
      at = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    } else if (/^you said so$/i.test(part)) {
      source = "You said so";
    } else if (/^from your texts$/i.test(part)) {
      source = "From your texts";
    } else if (/^tex noticed$/i.test(part)) {
      source = "Tex noticed";
    } else if (/^.{1,60} said so$/i.test(part)) {
      source = `${part.slice(0, -" said so".length).trim()} said so`;
    }
  }
  return source === null && at === undefined ? null : { source: source ?? "Tex noticed", at };
}

/** The first line of the note after its front matter, where the body starts. */
export function bodyStart(lines) {
  if (lines[0]?.trim() !== "---") return 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "---" || line === "...") return i + 1;
  }
  return 0;
}

/** A line as an about item (`null` for a blank line, a heading, a comment, a rule). */
export function itemOf(raw) {
  const trimmed = raw.trim();
  if (trimmed === "" || /^#{1,6}(\s|$)/.test(trimmed) || /^<!--/.test(trimmed) || /^-{3,}$/.test(trimmed)) return null;
  const bullet = BULLET.exec(raw)?.[0] ?? "";
  const rest = raw.slice(bullet.length).trim();
  const found = TRAILING.exec(rest);
  const marker = found ? markerOf(found[1]) : null;
  const text = marker ? rest.slice(0, found.index).trim() : rest;
  if (text === "") return null;
  return { bullet, text, marker: marker ? found[0] : "", source: marker?.source ?? "Tex noticed", at: marker?.at };
}

const sameText = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * `content` with every about line given a dated marker, for a save at `now`.
 *
 *  - A line that already has a dated marker is left as it is.
 *  - A line the stored note (`storedBody`, null for a new note) already had,
 *    word for word, keeps the stored line's marker, or its date: rewriting the
 *    whole note does not make an old line new. One the stored note had with no
 *    date stays undated, since the day it was written is not known.
 *  - Any other line is dated today, keeping the source it names (`(you said
 *    so)`), or `Tex noticed` when it names none.
 *
 * Front matter, headings, comments, rules and blank lines are left alone.
 */
export function stampAboutLines(content, storedBody, now) {
  if (typeof content !== "string") return content;
  const stored = new Map();
  if (typeof storedBody === "string") {
    const lines = storedBody.replace(/^﻿/, "").split("\n");
    for (let i = bodyStart(lines); i < lines.length; i++) {
      const entry = itemOf(lines[i]);
      if (entry !== null && (entry.at !== undefined || !stored.has(sameText(entry.text)))) stored.set(sameText(entry.text), entry);
    }
  }
  const today = dayOf(now);
  const lines = content.split("\n");
  for (let i = bodyStart(lines.map((line) => line.replace(/^﻿/, ""))); i < lines.length; i++) {
    const raw = lines[i];
    const entry = itemOf(raw);
    if (entry === null || entry.at !== undefined) continue;
    const cr = raw.endsWith("\r") ? "\r" : "";
    const line = raw.replace(/\s+$/, "");
    const before = stored.get(sameText(entry.text));
    if (before !== undefined && before.at === undefined) continue; // an old line nobody dated: when it was written is not known
    if (entry.marker === "") {
      lines[i] = before ? `${line}${before.marker.replace(/\s+$/, "")}${cr}` : `${line} (Tex noticed, ${today})${cr}`;
      continue;
    }
    const found = TRAILING.exec(line);
    lines[i] = `${line.slice(0, found.index)} (${found[1].trim()}, ${before ? dayOf(before.at) : today})${cr}`;
  }
  return lines.join("\n");
}
