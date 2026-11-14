/**
 * The Jobs page's writes to `@context-lc ai/`, over a reader and a writer
 * (`useNoteWriter`: read the version, write it back, so somebody's edit since
 * is refused). Kept free of React so every step can be tested with fakes.
 */

import { promotedText, withFrontKey, type Candidate, type JobPage } from "../../../aiModel";
import { experimentText } from "../../../aiExperiments";
import { withCaseCopied, withCaseEdited, withCaseRemoved, withCaseRestored, withNewCase, type CaseDraft } from "./caseEdits";

export interface NoteIo {
  read(path: string): Promise<string>;
  /** `change` answers null to leave the note as it is. */
  write(path: string, change: (text: string | null) => string | null): Promise<void>;
  /** Opens a link; false when it could not. */
  open(url: string): Promise<boolean>;
}

export interface JobWrites {
  saveCase(path: string, number: number, draft: CaseDraft): Promise<void>;
  newCase(path: string): Promise<number>;
  copyCase(path: string, number: number): Promise<number>;
  /** Removes it and answers the case's own lines, for Undo. */
  deleteCase(path: string, number: number): Promise<string[]>;
  /** Puts a deleted case back into the list as it is now, under its old number when that is free. */
  restoreCase(path: string, block: readonly string[]): Promise<void>;
  newExperiment(page: JobPage): Promise<string>;
  makeLive(page: JobPage, candidate: Candidate): Promise<void>;
  /** Opens the test bench; false when the link could not be opened. */
  runBoth(): Promise<boolean>;
}

export const RUN_TESTS_URL = "https://github.com/Supa-Media/context/actions/workflows/ai-benchmark.yml";

export function makeJobWrites(io: NoteIo, me: string, today: () => string = () => new Date().toISOString().slice(0, 10)): JobWrites {
  const { read, write } = io;
  return {
    async saveCase(path, number, draft) {
      await write(path, (text) => (text === null ? null : withCaseEdited(text, number, draft)));
    },
    async newCase(path) {
      let number = 0;
      await write(path, (text) => {
        if (text === null) return null;
        const made = withNewCase(text);
        number = made.number;
        return made.text;
      });
      return number;
    },
    async copyCase(path, number) {
      let made = 0;
      await write(path, (text) => {
        if (text === null) return null;
        const copy = withCaseCopied(text, number);
        made = copy.number;
        return copy.text;
      });
      return made;
    },
    async deleteCase(path, number) {
      let block: string[] = [];
      await write(path, (text) => {
        if (text === null) return null;
        const removed = withCaseRemoved(text, number);
        block = removed.block;
        return removed.text;
      });
      return block;
    },
    async restoreCase(path, block) {
      await write(path, (text) => (text === null ? null : withCaseRestored(text, block)));
    },
    async newExperiment(page) {
      if (page.row.setup === null) throw new Error("Nothing is live on this job to copy");
      const liveText = await read(page.row.setup.path);
      const taken = new Set([...page.candidates, ...page.retired].map((item) => item.name));
      let n = page.candidates.length + 1;
      while (taken.has(`experiment-${n}`)) n += 1;
      const name = `experiment-${n}`;
      const change = "Name the one thing that changes";
      let wrote = false;
      await write(`ai/setups/${page.job.key}/${name}.md`, (existing) => {
        if (existing !== null) return null;
        wrote = true;
        return experimentText(liveText, { job: page.job.key, basedOn: page.live ?? page.row.setup!.name, change, by: me });
      });
      // Never claim a copy that was not written: a note by that name already existed.
      if (!wrote) throw new Error(`A setup called ${name} already exists; reload and try again`);
      return name;
    },
    /**
     * The setup notes first, production last: production is what runs, so it
     * changes only once the notes say the same. If production's write fails,
     * the notes are put back as they were.
     */
    async makeLive(page, candidate) {
      const liveRow = page.row.setup;
      if (liveRow === null) throw new Error("Nothing is live on this job to replace");
      const mineText = await read(candidate.row.path);
      const was = page.candidates.find((item) => item.name === page.live && item.name !== candidate.name) ?? null;
      const wasText = was ? await read(was.row.path) : null;
      await write(candidate.row.path, (text) => withFrontKey(text ?? mineText, "status", "live"));
      try {
        if (was) await write(was.row.path, (text) => (text === null ? null : withFrontKey(text, "status", "retired")));
        await write(liveRow.path, () => promotedText(mineText, { job: page.job.key, from: candidate.name, day: today(), by: me }));
      } catch (error) {
        await write(candidate.row.path, () => mineText).catch(() => {});
        if (was && wasText !== null) await write(was.row.path, () => wasText).catch(() => {});
        throw error;
      }
    },
    // The bench runs on GitHub Actions: no token here can start it, so this opens its run form.
    runBoth() {
      return io.open(RUN_TESTS_URL);
    },
  };
}
