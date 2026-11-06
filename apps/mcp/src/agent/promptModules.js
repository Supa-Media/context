/**
 * TEX'S PROMPT IN MODULES, ONE NOTE EACH (Dev2, 2026-11-06: "modular prompts so that we know what we are changing",
 * kept "reusable across agents"; "split into modules now").
 *
 * The texting setup (`ai/production/texting-assistant.md`) may name, instead of carrying its rules in its body, the
 * module notes each kind of turn is built from:
 *
 *     modules:
 *       texts: [about-tex, tools, answering, sound-like-a-person]
 *       group: [about-tex, tools, answering, sound-like-a-person]
 *       job: [about-tex, tools, answering]
 *
 * Each name is a note `ai/production/prompt/<name>.md` in the same pinned workspace. A turn's rules are its kind's
 * modules in the order named, each note's body (front matter, if any, is for people and never sent), joined by a
 * blank line. A module shared by several kinds is one note, so a change to it is one change everywhere it is used.
 * `texts` is required; `group` and `job` fall back to it. With `modules`, the setup's body is its description for
 * people and is never sent.
 *
 * Read with the setup, in the same warm copy (`warmCopy.js`), so a warm text reads nothing more. A module that is
 * named and can't be read refuses the whole setup, as any other fault in it does: half a prompt is never run.
 */

export const MODULE_FOLDER = "ai/production/prompt";

/** The kinds of turn a setup may give modules to; the first is required and the default. */
export const MODULE_KINDS = ["texts", "group", "job"];

const NAME = /^[a-z][a-z0-9-]{0,47}$/;

/** The most modules one kind may name, and the most distinct modules a setup may read. */
const MAX_PER_KIND = 24;
const MAX_MODULES = 40;

/** The marker that says a warm copy holds a setup and its modules, not the setup's raw text. */
const ASSEMBLED = "context-tex-setup-modules/1";

export const modulePath = (name) => `${MODULE_FOLDER}/${name}.md`;

/**
 * The `modules:` section as `{texts, group, job}` lists of names (absent kinds fall back to `texts`), `null` when
 * the setup names none, or `undefined` when it is malformed (the setup is then refused).
 */
export function readModuleLists(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const lists = {};
  for (const [kind, names] of Object.entries(value)) {
    if (!MODULE_KINDS.includes(kind)) return undefined;
    if (!Array.isArray(names) || names.length === 0 || names.length > MAX_PER_KIND) return undefined;
    if (!names.every((name) => typeof name === "string" && NAME.test(name))) return undefined;
    if (new Set(names).size !== names.length) return undefined;
    lists[kind] = names;
  }
  if (lists.texts === undefined) return undefined;
  for (const kind of MODULE_KINDS) lists[kind] ??= lists.texts;
  if (new Set(MODULE_KINDS.flatMap((kind) => lists[kind])).size > MAX_MODULES) return undefined;
  return lists;
}

/** Every module the lists name, once each, in first-named order. */
export function namedModules(lists) {
  return [...new Set(MODULE_KINDS.flatMap((kind) => lists[kind]))];
}

/** A module note's text as sent: its body, without front matter, trimmed. */
export function moduleBody(text) {
  const source = String(text ?? "").replace(/^﻿/, "");
  const front = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  return (front ? source.slice(front[0].length) : source).trim();
}

/** Each kind's rules: its modules' bodies in order, or `undefined` when a named module has no text. */
export function moduleTexts(lists, modules) {
  const out = {};
  for (const kind of MODULE_KINDS) {
    const parts = lists[kind].map((name) => (typeof modules?.[name] === "string" ? moduleBody(modules[name]) : ""));
    if (parts.some((part) => part === "")) return undefined;
    out[kind] = parts.join("\n\n");
  }
  return out;
}

/**
 * The setup's raw text and, when its front matter names modules, each module's text, as one string a warm copy
 * keeps. `readNote(path)` answers a note's text or null. A setup that names no modules is kept as its own text.
 * Null when a named module can't be read.
 *
 * @param {string} raw the setup note's text
 * @param {(path: string) => Promise<string|null>} readNote
 * @param {(raw: string) => object|null} frontOf the setup's front matter, as `production.js` reads it
 */
export async function assembleSetup(raw, readNote, frontOf) {
  if (typeof raw !== "string") return null;
  const lists = readModuleLists(frontOf(raw)?.modules);
  if (lists === null || lists === undefined) return raw; // none named, or malformed: the parse refuses the latter
  const names = namedModules(lists);
  const texts = await Promise.all(names.map((name) => readNote(modulePath(name)).catch(() => null)));
  const missing = names.filter((_, index) => typeof texts[index] !== "string");
  if (missing.length > 0) {
    console.log(JSON.stringify({ event: "tex_setup_module_missing", modules: missing }));
    return null;
  }
  return JSON.stringify({ kind: ASSEMBLED, raw, modules: Object.fromEntries(names.map((name, index) => [name, texts[index]])) });
}

/** `{raw, modules}` from what `assembleSetup` kept; a plain setup's text is `{raw, modules: null}`. */
export function splitAssembled(text) {
  if (typeof text !== "string") return { raw: null, modules: null };
  if (!text.startsWith("{")) return { raw: text, modules: null };
  try {
    const parsed = JSON.parse(text);
    if (parsed?.kind !== ASSEMBLED || typeof parsed.raw !== "string" || parsed.modules === null || typeof parsed.modules !== "object") return { raw: null, modules: null };
    return { raw: parsed.raw, modules: parsed.modules };
  } catch {
    return { raw: null, modules: null };
  }
}

/** Which kind of turn this is, for its modules. */
export function turnKind({ group = null, job = null } = {}) {
  return job !== null && job !== undefined ? "job" : group !== null && group !== undefined ? "group" : "texts";
}

/** The rules a turn of `kind` is given from a parsed setup: its modules when it has them, else the body. */
export function setupPromptFor(setup, kind) {
  if (setup?.prompts && typeof setup.prompts[kind] === "string") return setup.prompts[kind];
  return setup?.prompt ?? null;
}
