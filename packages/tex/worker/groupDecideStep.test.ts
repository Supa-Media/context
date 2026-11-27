/**
 * A group's Decide is a step of its own, as a person's own chat's is (`stepEvents.test.ts`; Dev2, 2026-11-13: every step
 * logs its input, output and time). Before 2026-11-27 a group's verdict went only to the console, so a Lab test chat's
 * card said Decide "logged no run: the code did not run it" when it had run and said quiet, and the app's step log
 * had no Decide either (launch-day rehearsal, 2026-11-27).
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-27):
 *  1. `ask` in `groupTurn.ts` not calling `logStep` → both checks fail.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import {
  BO,
  chatLog,
  LINES,
  setup,
  silent,
  answerAll,
} from "./groupWorld.testing";

for (const { name, groupId } of LINES) {
  describe(`a group's Decide is kept as a step, ${name}`, () => {
    it("a silent verdict is kept with what Decide was given and said", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, {
        decide: (body) => (w.decided.length === 1 ? answerAll(body) : silent()),
      });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("lol nice", { from: BO }), 10);
      await drainGroup(storage, w.deps);
      const steps = (await chatLog(storage, w, groupId)).filter(
        (event) => event.kind === "step" && event.step?.name === "decide",
      );
      expect(steps).toHaveLength(1);
      expect(steps[0]?.step).toMatchObject({
        name: "decide",
        ok: true,
        input: { candidates: [expect.any(String)] },
        output: { act: "silent" },
      });
      expect(w.asks).toHaveLength(1);
    });

    it("an answer verdict is kept too, and the step is never a line of the chat the judge reads next", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: answerAll });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("and tomorrow?"), 10);
      await drainGroup(storage, w.deps);
      const steps = (await chatLog(storage, w, groupId)).filter(
        (event) => event.kind === "step" && event.step?.name === "decide",
      );
      expect(steps.map((event) => event.step?.output?.act)).toContain("answer");
      expect(String(w.decided.at(-1)?.transcript ?? "")).not.toContain(
        "decide",
      );
    });
  });
}
