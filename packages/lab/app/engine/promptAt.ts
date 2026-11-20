/**
 * The prompt a turn ran on, walked back from its version (Dev2, 2026-11-14: "once we know the version ... when I click
 * on something, I should be able to walk back. What was the prompt for this version, what were the context modules
 * that were loaded in, the different settings").
 *
 * A turn logs, per model round, its prompt's modules as ids, lengths and fingerprints (`promptManifest.js`), and the
 * commit that ran (`texVersion.js`), never the words. `scripts/tex-prompt-catalog.mjs` writes, at every commit, the
 * words of each module that commit builds from the repository alone, keyed by fingerprint; the Lab reads that file AT
 * the turn's commit, so a module's words are shown only when its fingerprint proves they are the words that ran. A
 * module built from the person's notes or the moment (the time, why the turn ran, the thread) is kept with its words
 * since 2026-11-17 (`promptManifest.js` `keptWordsOf`; Dev2 chose it after a turn's false "@shyoh tagged you" could not
 * be seen in Replay), shown only when they hash to the fingerprint logged; an older turn's is named, sized and said
 * where it came from.
 */
import type { LedgerEntry } from "../fromApp/texPageTypes";

export type PromptModule = { id: string; n: number; h: string };
export type PromptRound = { model: string | null; modules: PromptModule[] };
export type TurnPrompt = { code: string | null; setup: string | null; rounds: PromptRound[]; inputs: { at?: number; timeZone?: string; model?: string; history?: number } | null; kept: Record<string, string> };

const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const COMMIT = /^[0-9a-f]{7,40}$/;
const FP = /^[0-9a-f]{8}$/;

/** The prompt one turn's reply (or a check-in's note) logged, or null when it logged none. */
export function turnPromptOf(entries: LedgerEntry[], turn: string | null): TurnPrompt | null {
  if (!turn) return null;
  const mine = entries.filter((e) => e.turn === turn);
  const holder = mine.find((e) => e.kind === "reply" && rec((e as Record<string, unknown>).timing)) ?? mine.find((e) => rec((e as Record<string, unknown>).timing));
  const h = holder as Record<string, unknown> | undefined;
  const timing = rec(h?.timing);
  const rounds: PromptRound[] = [];
  let inputs: TurnPrompt["inputs"] = null;
  const kept: Record<string, string> = {};
  for (const r of Array.isArray(timing?.rounds) ? (timing!.rounds as unknown[]) : []) {
    const p = rec(rec(r)?.prompt);
    const modules = (Array.isArray(p?.modules) ? (p!.modules as unknown[]) : [])
      .map(rec)
      .filter((m): m is Record<string, unknown> => m !== null && typeof m.id === "string" && typeof m.h === "string" && FP.test(m.h))
      .map((m) => ({ id: m.id as string, n: typeof m.n === "number" ? m.n : 0, h: m.h as string }));
    for (const [h, w] of Object.entries(rec(p?.words) ?? {})) if (FP.test(h) && typeof w === "string") kept[h] ??= w;
    if (!modules.length) continue;
    rounds.push({ model: typeof rec(r)?.model === "string" ? (rec(r)!.model as string) : typeof rec(p?.inputs)?.model === "string" ? (rec(p!.inputs)!.model as string) : null, modules });
    inputs ??= rec(p?.inputs) as TurnPrompt["inputs"];
  }
  const version = rec(h?.version) ?? mine.map((e) => rec((e as Record<string, unknown>).version)).find((v) => v !== null) ?? null;
  const code = typeof version?.code === "string" && COMMIT.test(version.code) ? version.code : null;
  const setup = typeof version?.setup === "string" ? version.setup : null;
  if (!rounds.length && !code) return null;
  return { code, setup, rounds, inputs, kept };
}

/** Where each module the repository can't hold comes from, in words (`turnPrompt.js`). */
const SOURCES: Record<string, string> = {
  "context/thread": "the thread note of the chat it was typed in",
  "context/aboutMe": "their about-me note (tex/about.md)",
  "context/calendar": "a copy of their next 7 days of calendar",
  "context/jobs": "their jobs note (tex/jobs.md)",
  "context/voice": "how they talk (tex/voice.md)",
  "context/workspaces": "the workspaces they can reach",
  "context/progress": "the chat's progress level",
  "preamble/now": "the time and their time zone",
  "preamble/calendarAge": "how old the calendar copy was",
  "preamble/turnNote": "who tagged it, the thread, the jobs running then",
  "preamble/volatile": "the model answering, what earlier texts used, the note open in front of them",
  "preamble/nudge": "the push-back nudge for an opinion or a goal",
};

/** Modules the repository builds alone, which the catalogue holds; the rest are built from the person's own words. */
const REPO_BUILT = new Set(["context/web", "context/progress", "context/transcripts", "context/checkIns", "context/attention", "preamble/plan"]);
export const fromRepo = (id: string) => id.startsWith("stable/") || REPO_BUILT.has(id);

/** What a module is, for a person: the stable rules, or where its words came from. */
export function moduleSource(id: string): string {
  if (id.startsWith("stable/")) return "Tex's rules for this kind of turn: " + id.slice(7).split("/").join(", ");
  return SOURCES[id] ?? "built when the turn ran";
}

/** The catalogue file for one commit, as `scripts/tex-prompt-catalog.mjs` writes it. */
type Catalog = { v: 2; modules: Record<string, { id: string; kinds: string[]; n: number; at: number[] }>; lines: string[] };

/** The repository the deployed commits are in. A self-hosted fork names its own here. */
export const REPO = "Supa-Media/context";
/**
 * Where the catalogue is at a commit: `packages/lab/app` since the Lab became its own package (2026-11-20), and
 * `apps/mobile/features/tex/lab` before. A turn that ran on an older commit is read from the older place.
 */
export const CATALOG_PATHS = ["packages/lab/app/promptCatalog.generated.json", "apps/mobile/features/tex/lab/promptCatalog.generated.json"];
export const commitUrl = (code: string) => `https://github.com/${REPO}/commit/${code}`;

const fetched = new Map<string, Promise<Catalog | null>>();

/** The catalogue at `code`, or null when that commit has none (it predates the catalogue) or it can't be read. */
export function catalogAt(code: string, get: typeof fetch = fetch): Promise<Catalog | null> {
  if (!COMMIT.test(code)) return Promise.resolve(null);
  let p = fetched.get(code);
  if (!p) {
    const at = (path: string) => get(`https://raw.githubusercontent.com/${REPO}/${code}/${path}`);
    p = at(CATALOG_PATHS[0])
      .then((r) => (r.ok ? r : at(CATALOG_PATHS[1])))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && j.v === 2 && Array.isArray(j.lines) && rec(j.modules) ? (j as Catalog) : null))
      .catch(() => null);
    fetched.set(code, p);
    // A failed read is tried again next time; a commit's file never changes once it is there.
    p.then((c) => {
      if (!c) fetched.delete(code);
    });
  }
  return p;
}

/** FNV-1a over UTF-16 code units, 8 hex digits: the gateway's `promptManifest.js` `fingerprint`, the same bytes. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * A module's words that ran, or null: from the catalogue at the turn's commit when its fingerprint is there, else from
 * the words the turn kept, only when they hash to the fingerprint it logged (never words that merely sit beside it).
 */
export function wordsOf(catalog: Catalog | null, m: PromptModule, kept: Record<string, string> | null = null): string | null {
  const row = catalog?.modules[m.h];
  if (row && row.id === m.id) return row.at.map((i) => catalog!.lines[i] ?? "").join("\n");
  const own = kept?.[m.h];
  return typeof own === "string" && m.n === own.length && fingerprint(own) === m.h ? own : null;
}

/** The time a turn's prompt was told, in its own time zone, for the `preamble/now` row. */
export function toldTime(inputs: TurnPrompt["inputs"]): string | null {
  if (!inputs || typeof inputs.at !== "number") return null;
  try {
    return new Date(inputs.at).toLocaleString("en-US", { timeZone: inputs.timeZone || "UTC", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  } catch {
    return new Date(inputs.at).toISOString();
  }
}
