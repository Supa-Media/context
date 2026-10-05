/**
 * Synthetic, deterministic benchmark corpora with judged queries
 * (docs/design/link-graph/PLAN.md, Phase 0).
 *
 * `generateCorpus({ size, seed })` returns `{ notes, queries }`:
 *
 * - `notes`: `{ path, text, visibility }`, `visibility` being "private" or
 *   "team". Exactly `size` notes.
 * - `queries`: `{ query, relevant, kind }`, `relevant` being the paths a
 *   correct search returns. `kind` is the query class the per-class table in
 *   BASELINE.md groups by.
 *
 * The judged notes are a fixed set planted into every size, so the same
 * questions are asked of 100, 1,000 and 10,000 notes and only the haystack
 * grows. Filler is drawn from made-up words (`fz` plus a number) that no query
 * uses, so a filler note is never accidentally relevant.
 *
 * Every value is fake, as everywhere else in this repository.
 */

import { renderChannelDayNote } from "../../../packages/communications/src/note.js";

/** xorshift32: the same seed gives the same corpus, with no dependency. */
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

const FILLER_VOCABULARY = 5_000;

function filler(next, words) {
  const out = [];
  for (let i = 0; i < words; i += 1) out.push(`fz${next() % FILLER_VOCABULARY}`);
  return out.join(" ");
}

/** A body of `chars` characters at least, split into paragraphs. */
function longFiller(next, chars) {
  const paragraphs = [];
  let length = 0;
  while (length < chars) {
    const paragraph = filler(next, 60);
    paragraphs.push(paragraph);
    length += paragraph.length + 2;
  }
  return paragraphs.join("\n\n");
}

/**
 * Word families for the morphology class: the note uses some forms, the query
 * another, so only a stemmer (or a lucky prefix) connects them. Each family's
 * words appear nowhere else in the corpus.
 */
const FAMILIES = [
  { note: ["deployed the gateway", "deployment window"], query: "deploying" },
  { note: ["connected accounts", "a connection pool"], query: "connecting" },
  { note: ["argued for retention", "the argument stands"], query: "arguing" },
  { note: ["generous quota", "their generosity"], query: "generously" },
  { note: ["migrated buckets", "migrations ran"], query: "migrating" },
  { note: ["happily accepted", "happiness metric"], query: "happy" },
  { note: ["relational schema", "relations table"], query: "relationship" },
  { note: ["archived folders", "archives grow"], query: "archiving" },
];

const CJK = [
  { text: "数据库迁移计划已经确认，下周开始执行。", query: "迁移", lang: "zh" },
  { text: "我们明天开会讨论搜索质量。", query: "搜索", lang: "zh" },
  { text: "東京の会議メモを共有します。", query: "会議", lang: "ja" },
  { text: "来週のリリース計画を確認してください。", query: "リリース", lang: "ja" },
];

const CODE = [
  { text: "Call `fetchUserProfile(userId)` before rendering.", query: "user profile" },
  { text: "The column `invoice_total_cents` is an integer.", query: "invoice total" },
  { text: "Set `MAX_RETRY_COUNT` to three in the worker.", query: "retry count" },
  { text: "`parseHttpHeader` rejects folded lines.", query: "http header" },
];

const pad = (n, width = 5) => String(n).padStart(width, "0");

/**
 * The judged notes. Each entry is `{ note, query }`, where `note` is either one
 * note or several and `query.relevant` names the paths that answer it.
 */
function judged(next) {
  const planted = [];
  const plant = (notes, query, relevant, kind) => planted.push({ notes, query: { query, relevant, kind } });

  // exact: a rare term near the top of an ordinary note.
  for (let i = 0; i < 8; i += 1) {
    const path = `1-projects/exact-${i}.md`;
    plant([{ path, text: `# Exact ${i}\n\nThe codename is qzexact${i}. ${filler(next, 120)}\n` }], `qzexact${i}`, [path], "exact");
  }

  // title: the term is in the title only.
  for (let i = 0; i < 4; i += 1) {
    const path = `2-areas/title-${i}.md`;
    plant([{ path, text: `# Qztitle${i} review\n\n${filler(next, 150)}\n` }], `qztitle${i}`, [path], "title");
  }

  // deep: the term sits past the R2 index's 2,048-character cap; two of them
  // past 64,000 characters, the new projection cap.
  for (let i = 0; i < 6; i += 1) {
    const path = `3-resources/deep-${i}.md`;
    const before = longFiller(next, i < 4 ? 3_000 + i * 2_000 : 66_000);
    plant([{ path, text: `# Deep ${i}\n\n${before}\n\nThe answer is qzdeep${i}.\n` }], `qzdeep${i}`, [path], "deep");
  }

  // multi: two words that occur together in one note and alone in decoys.
  for (let i = 0; i < 4; i += 1) {
    const both = `1-projects/multi-${i}.md`;
    plant(
      [
        { path: both, text: `# Multi ${i}\n\nqzalpha${i} and qzbeta${i} meet here. ${filler(next, 100)}\n` },
        { path: `1-projects/multi-${i}-a.md`, text: `# Decoy A ${i}\n\nonly qzalpha${i}. ${filler(next, 100)}\n` },
        { path: `1-projects/multi-${i}-b.md`, text: `# Decoy B ${i}\n\nonly qzbeta${i}. ${filler(next, 100)}\n` },
      ],
      `qzalpha${i} qzbeta${i}`,
      [both],
      "multi"
    );
  }

  // morph: the query is a form of the word the note never uses.
  FAMILIES.forEach((family, i) => {
    const paths = family.note.map((_, j) => `2-areas/morph-${i}-${j}.md`);
    plant(
      family.note.map((phrase, j) => ({ path: paths[j], text: `# Morph ${i}.${j}\n\nWe ${phrase}. ${filler(next, 120)}\n` })),
      family.query,
      paths,
      "morph"
    );
  });

  // cjk: the query is a word inside an unspaced run.
  CJK.forEach((entry, i) => {
    const path = `0-inbox/cjk-${entry.lang}-${i}.md`;
    plant([{ path, text: `# CJK ${i}\n\n${entry.text}\n\n${filler(next, 40)}\n` }], entry.query, [path], "cjk");
  });

  // code: the query names the parts of an identifier.
  CODE.forEach((entry, i) => {
    const path = `1-projects/code-${i}.md`;
    plant([{ path, text: `# Code ${i}\n\n${entry.text}\n\n${filler(next, 100)}\n` }], entry.query, [path], "code");
  });

  // message: a term in the last message of a long channel-day note.
  for (let i = 0; i < 3; i += 1) {
    const date = `2026-03-${String(i + 1).padStart(2, "0")}`;
    const path = `0-inbox/email/name-at-example-com/${date}.md`;
    const events = [];
    for (let m = 0; m < 40; m += 1) {
      events.push({
        channel: "email",
        account: "name-at-example-com",
        messageId: `<b${i}m${m}@mail.example.net>`,
        threadId: `t${i}-${m % 5}`,
        sentAt: `${date}T08:${String(m).padStart(2, "0")}:00.000Z`,
        subject: `Update ${m}`,
        from: { name: "Ada Example", address: "ada@example.net" },
        to: [{ address: "name@example.com" }],
        body: `${filler(next, 80)}${m === 39 ? ` qzmessage${i}` : ""}`,
        attachments: [],
      });
    }
    const text = renderChannelDayNote({
      channel: "email",
      account: "name-at-example-com",
      address: "name@example.com",
      date,
      nonce: "0123456789abcdef",
      now: `${date}T18:00:00.000Z`,
      events,
    });
    plant([{ path, text }], `qzmessage${i}`, [path], "message");
  }

  return planted;
}

/**
 * Filler that still has the shapes later phases care about: duplicate
 * basenames across folders, and hub notes many others link to.
 */
function fillerNote(next, i) {
  const folder = ["1-projects", "2-areas", "3-resources", "0-inbox"][i % 4];
  const base = i % 10 === 0 ? `meeting-${i % 50}` : `note-${pad(i)}`;
  const link = i % 7 === 0 ? `\n\nSee [[hub-${i % 5}]].` : "";
  return { path: `${folder}/${i % 10 === 0 ? `sub-${i % 3}/` : ""}${base}.md`, text: `# Note ${i}\n\n${filler(next, 120)}${link}\n` };
}

/** @param {{ size: number, seed?: number }} options */
export function generateCorpus({ size, seed = 1 }) {
  const next = rng(seed);
  const planted = judged(next);
  const notes = planted.flatMap((entry) => entry.notes);
  if (notes.length > size) throw new Error(`size ${size} is smaller than the ${notes.length} judged notes`);

  for (let h = 0; h < 5 && notes.length < size; h += 1) {
    notes.push({ path: `3-resources/hub-${h}.md`, text: `# Hub ${h}\n\n${filler(next, 80)}\n` });
  }
  const taken = new Set(notes.map((note) => note.path));
  for (let i = 0; notes.length < size; i += 1) {
    const note = fillerNote(next, i);
    if (!taken.has(note.path)) {
      taken.add(note.path);
      notes.push(note);
    }
  }

  // Mixed visibility, decided by position so it is deterministic: one note in
  // three is private.
  notes.forEach((note, i) => {
    note.visibility = i % 3 === 0 ? "private" : "team";
  });
  return { notes, queries: planted.map((entry) => entry.query) };
}
