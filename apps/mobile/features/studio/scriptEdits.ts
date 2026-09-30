import {
  castActorNamed,
  insertCastStep,
  moveCastStep,
  renameCastActor,
  replaceCastStep,
  splitWebsiteCast,
  withCastActor,
  withCastKind,
  withCastWords,
  type CastActor,
  type CastEditKind,
  type CastStep,
} from "@context/shared";

/**
 * A change to the open note: given the text as it stands, the text it should
 * become. Written through the room like a keystroke, so it merges with anyone
 * typing and with an agent's write (`noteWriter`); why not, or `null`.
 */
export type WriteScript = (change: (current: string) => string) => string | null;

/** What the rail can do to the script. Each reads the note as it is at that moment. */
export interface ScriptEdits {
  words: (index: number, words: string) => void;
  /** A comment's quoted words: what it is about. */
  quote: (index: number, quote: string) => void;
  actor: (index: number, actor: CastActor) => void;
  kind: (index: number, kind: CastEditKind, fallback: CastActor) => void;
  remove: (index: number) => void;
  insert: (index: number, step: CastStep) => void;
  move: (from: number, to: number) => void;
  /** Everyone named `from` is now `to`; `false` when `to` is not a name the script can use. */
  rename: (from: string, to: string) => boolean;
}

/** One step of the note as it stands, changed by `change`; the note as it was when that fails. */
function stepEdit(index: number, change: (step: CastStep) => CastStep | null): (current: string) => string {
  return (current) => {
    const step = splitWebsiteCast(current).steps[index];
    if (step === undefined) return current;
    const next = change(step);
    return next === null ? current : replaceCastStep(current, index, next);
  };
}

export function scriptEdits(write: WriteScript): ScriptEdits {
  return {
    words: (index, words) => void write(stepEdit(index, (step) => withCastWords(step, words))),
    quote: (index, quote) =>
      void write(
        stepEdit(index, (step) => (step.kind === "comment" && quote.trim() !== "" ? { ...step, quote: quote.replace(/\s+/g, " ").trim() } : null)),
      ),
    actor: (index, actor) => void write(stepEdit(index, (step) => withCastActor(step, actor))),
    kind: (index, kind, fallback) => void write(stepEdit(index, (step) => withCastKind(step, kind, fallback))),
    remove: (index) => void write((current) => replaceCastStep(current, index, null)),
    insert: (index, step) => void write((current) => insertCastStep(current, index, step)),
    move: (from, to) => void write((current) => moveCastStep(current, from, to)),
    rename: (from, to) => {
      const actor = castActorNamed(to);
      if (actor === null) return false;
      if (actor.name !== from) write((current) => renameCastActor(current, from, actor));
      return true;
    },
  };
}
