/**
 * Search's settings as the Lab shows them: a short label and a one-line tip for each setting a search step reads, the
 * check a typed value must pass before it is saved, and the rank comparison the Search page's "Try a search" panel
 * draws between main and the draft. Pure, so the panel and the tests share one rule.
 *
 * The bounds are the schema's (`apps/mcp/src/search/config/searchConfig.cjs`): a value out of them is refused here, and
 * the gateway would refuse it too, so the Lab never saves what the gateway would not run.
 */
import { SEARCH_SETTINGS_BOUNDS } from "../../../../apps/mcp/src/search/config/searchConfig.cjs";

export const SETTING_TEXT: Readonly<Record<string, { label: string; tip: string }>> = {
  rrfK: { label: "Rank constant", tip: "A hit at rank r adds 1/(k+r+1); lower favours the top of each list." },
  hits: { label: "Hits shown", tip: "How many ranked hits the search returns." },
  titleWeight: { label: "Title weight", tip: "How much a match in the title counts." },
  phraseBonus: { label: "Phrase bonus", tip: "Extra score when the query's words appear together in the title or file name." },
  snippetPhraseBonus: { label: "Phrase-in-text bonus", tip: "Extra score when the query's words appear together only in the note's text, as a note quoting the question does." },
  inboxPrior: { label: "Inbox weight", tip: "How much weight a note still in the Inbox (not filed) gets against a filed one." },
  rerankTop: { label: "Notes reranked", tip: "How many of each workspace's first notes the reranker reads beside the query." },
  rerankChars: { label: "Rerank text length", tip: "How many characters of each note the reranker reads: fewer is faster." },
  readLate: { label: "Read the rest late", tip: "1: Rerank reads the notes Rerank word hits did not (a second call). 0: they keep their places unread, with no call after the snippets." },
  waitAfterMeaning: { label: "Wait after meaning (ms)", tip: "Once meaning has answered, how much longer a search waits for a workspace's word-hit rerank; past it that workspace's hits keep the word search's order, unread. Lower is faster." },
  rerankWeight: { label: "Rerank weight", tip: "How much the reranker's order counts: 1 counts as much as the word search's." },
  sharedWords: { label: "One word scale (0 or 1)", tip: "1: across workspaces, every word hit is scored with every workspace's word statistics pooled, so a word rare in one small workspace no longer counts as rare everywhere. 0: each workspace's own rank." },
  workspaceWeight: { label: "Workspace weight floor", tip: "Above 0: each workspace's hits are weighed by its share of the best word evidence, never below this. 0: every workspace counts the same." },
  loosePenalty: { label: "Loose-hit penalty", tip: "Pulls down a hit that only matches loosely." },
  boostFactor: { label: "Named-workspace boost", tip: "Multiplies the rank of a workspace the search names." },
  meaningFloor: { label: "Meaning floor", tip: "The lowest meaning score a hit may have and still rank." },
  looseReads: { label: "Meaning-only reads (no full match)", tip: "How many notes are read in full when only the meaning matches." },
  logPrior: { label: "Archive and log weight", tip: "How much weight archive and log notes get against the rest." },
  minScore: { label: "Meaning cut-off", tip: "A note the meaning search scores below this is left out." },
  extraNotes: { label: "Meaning-only notes added", tip: "Notes found by meaning alone, added after the full matches." },
  snippetChars: { label: "Snippet length", tip: "Characters of each note shown under its title." },
  openMine: { label: "Your opens weight", tip: "How much each of your own opens of a note lifts it, by the logarithm of the count; only a note holding every word of the query." },
  openPeople: { label: "Others' opens weight", tip: "How much other people's opens of a note lift it, by the logarithm of the count; only a note holding every word." },
  openAi: { label: "AI reads weight", tip: "How much AI clients' reads of a note lift it, kept small because AI reads what it later discards; only a note holding every word." },
  contentWords: { label: "Content-word match (0 or 1)", tip: "1: when some note holds every word of the query, the hits are the notes holding every word that is not filler (what, did, we), so a question finds the note and not only the transcripts that asked it. 0: every word, filler too." },
};

/** A setting's label, or its name when it has none (a setting the Lab does not know yet still shows). */
export const settingLabel = (name: string): string => SETTING_TEXT[name]?.label ?? name;

export type SettingCheck = { ok: true; value: number } | { ok: false; why: string };

/**
 * A typed value for one setting: the number when it may be saved, or why not, naming the bound. Text that is not a
 * number, a value out of its bounds, and a fraction where the setting must be whole are all refused, and nothing is
 * saved on a refusal.
 */
export function checkSetting(name: string, raw: string | number): SettingCheck {
  const bound = SEARCH_SETTINGS_BOUNDS[name];
  if (!bound) return { ok: false, why: `${name} is not a search setting` };
  const label = settingLabel(name);
  const text = typeof raw === "string" ? raw.trim() : String(raw);
  const value = text === "" ? NaN : Number(text);
  if (!Number.isFinite(value)) return { ok: false, why: `${label} must be a number` };
  if (value < bound.min || value > bound.max) return { ok: false, why: `${label} must be from ${bound.min} to ${bound.max}` };
  if (bound.integer && !Number.isInteger(value)) return { ok: false, why: `${label} must be a whole number` };
  return { ok: true, value };
}

/** A hit as the search answers it: its note's key and title, and whether only its meaning matched. */
export type RankHit = { key: string; title: string; meaningOnly?: boolean };
/** A draft's hit at its rank, with the rank main gave it (null when main did not have it) and which way it moved. */
export type RankMove = RankHit & { rank: number; was: number | null; move: "up" | "down" | "same" | "new" };

/**
 * Each of the draft's hits with its rank (1 is the top) and the rank main gave the same note. Moving up is a lower
 * rank number than main's; a note main did not have is "new".
 */
export function rankMoves(main: RankHit[], draft: RankHit[]): RankMove[] {
  const mainRank = new Map(main.map((h, i) => [h.key, i + 1] as const));
  return draft.map((h, i) => {
    const rank = i + 1;
    const was = mainRank.get(h.key) ?? null;
    const move: RankMove["move"] = was === null ? "new" : was > rank ? "up" : was < rank ? "down" : "same";
    return { ...h, rank, was, move };
  });
}
