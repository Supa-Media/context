import assert from "node:assert/strict";

import { historyReads, weekView } from "../../../../../packages/tex/gateway/agent/weekHistory.js";
import { texStep } from "../../../../../packages/tex/gateway/agent/texConfig.js";
import { eventEntry } from "../../../../../packages/tex/gateway/agent/ledger.js";

/**
 * Haiku 5.5 charges 5x past 100,000 input tokens. A saturated front door on
 * 2026-11-17 was 138,187 tokens: ~53,500 of system modules and the rest the
 * history caps (200k of the week + 120k of summaries). The system is what
 * answers; the caps were headroom past one busy week (~132k characters, 721
 * texts). These caps keep that week and the newer day summaries, and a full
 * history stays under the cliff even if the text is denser than it was measured.
 */
const SYSTEM_TOKENS = 54_000;
const CHARS_PER_TOKEN = 3.5;

export default {
  id: "history-under-cliff",
  incident:
    "2026-11-17: front-door prompts on Haiku 5.5 were about 103,000 tokens at the median and 138,187 on a heavy 1:1, past the 100,000-token point where input costs five times as much. The history caps were 200,000 characters of the last 7 days and 120,000 of older summaries.",
  cause:
    "The caps were larger than a full busy week (about 132,000 characters, from 40,000 characters keeping 218 of 721 texts) and larger than the summaries the read_day line already opens. A full history plus the system prompt crossed the price cliff.",
  path: "1:1 text",
  async run() {
    const reads = historyReads(texStep("fd"));
    const historyChars = reads.chat.chars + reads.summaries.chars;
    const tokens = SYSTEM_TOKENS + Math.ceil(historyChars / CHARS_PER_TOKEN);
    assert.equal(reads.chat.days, 7);
    assert.equal(reads.summaries.days, null, "older days stay summarized, not dropped as a class");
    assert.ok(reads.chat.chars >= 130_000, "the week that 40k cut to a third still fits");
    assert.ok(tokens < 100_000, `a full history plus the system is ${tokens} tokens, over the price cliff`);

    const start = Date.parse("2026-11-11T05:00:00Z");
    const entries = [];
    for (let i = 0; i < 40; i += 1) {
      const at = start + i * 60_000;
      entries.push(eventEntry({
        id: `${at}-${String(i).padStart(6, "0")}`,
        at,
        chat: "chat",
        from: { kind: "person", name: "ada", who: "h-ada" },
        kind: "text",
        text: i === 39 ? "the newest text" : `older text ${i} ${"x".repeat(80)}`,
      }));
    }
    const view = weekView({
      entries: entries.reverse(),
      chat: "chat",
      start,
      chars: 500,
      days: 7,
      preface: "",
    });
    assert.match(view.text, /the newest text/);
    assert.match(view.text, /oldest texts of the last 7 days are left out here for room; fetch id "day:<date>" opens any day whole/);
    assert.equal(view.text.includes("older text 0 "), false, "the cap drops the oldest texts, not the newest");
  },
};
