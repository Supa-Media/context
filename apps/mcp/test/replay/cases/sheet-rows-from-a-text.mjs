import assert from "node:assert/strict";
import { CAPABILITIES } from "../../../../../packages/tex/gateway/agent/capabilities.js";
import { oneToOne } from "../chats.mjs";

/** The round's tool results, read from the last request, which carries the whole turn so far. */
const resultsOf = (requests) =>
  (requests.at(-1)?.messages ?? [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === "tool_result")
    .map((block) => String(block.content ?? ""));

export default {
  id: "sheet-rows-from-a-text",
  incident: "2026-11-23 (the owner, building sheets): an area's metrics are to live in a sheet in the workspace, and a person texting \"log this week's monthly cost, 512\" should land one row there; before sheets Tex could only rewrite a .csv whole as words, and fetch read it as a file's text, with no rows to filter.",
  cause: "no write action changed a sheet's rows and fetch had no sheet read: write rows (sheetRows.js) and fetch on a .csv (readSheet.js) are new, and Tex's capability list names them.",
  path: "one-to-one text",
  // Sabotage (2026-11-23): drop the rows action from v2/actions.js and this fails on the append; drop the .csv branch in
  // translateFetch and it fails on "kind: sheet".
  async run() {
    assert.ok(CAPABILITIES.some((line) => line.actions.includes("write.rows")), "Tex's capability list says it can change a sheet's rows");
    const chat = await oneToOne();
    try {
      const path = "1-projects/finance/metrics.csv";
      await chat.text("log this week's monthly cost, 512", [
        { toolCalls: [{ name: "write", args: { action: "save", path, content: "date:date,metric:select,value:number\n2026-11-16,Monthly cost,507\n" } }] },
        { toolCalls: [{ name: "write", args: { action: "rows", path, args: { append: [{ date: "2026-11-23", metric: "Monthly cost", value: "$512" }] } } }] },
        { toolCalls: [{ name: "fetch", args: { id: path, args: { last: 1 } } }] },
        { text: "Logged: Monthly cost 512 for 2026-11-23." },
      ]);
      const results = resultsOf(chat.world.model.requests);
      assert.equal(results.length, 3, "the save, the append and the read were each answered");
      assert.match(results[0], /etag/, `the sheet was saved: ${results[0]}`);
      assert.match(results[1], /appended 1/, "the row was appended");
      assert.match(results[2], /^kind: sheet$/m, "fetch read the .csv as a sheet");
      assert.match(results[2], /\| 2026-11-23 \| Monthly cost \| 512 \|/, "and the new row is the last, its value written as a number");
    } finally {
      chat.restore();
    }
  },
};
