// Every 5 minutes, read what the Photon bridge logged and say whether Tex's
// iMessage line is holding texts back (Dev2, 2026-11-25). That day one group's
// members change failed on every delivery and held every text on the line for
// over 20 minutes, and nothing told anyone. The bridge now keeps order per chat
// and logs `bridge.alert` when a chat is held 2 minutes, when it parks an event
// and when it drops a parked one (infra/photon-bridge/src/pump.ts). Only codes
// and counts are read or written: never words, numbers or chat ids, because the
// alert lands in a public issue.
//
// Usage: node scripts/tex-line-alert.mjs > report.md  (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)
// Exit 0 with an empty report: healthy. A non-empty report: open or update the alert issue.

import { code } from "./log-codes.mjs";
import { readEvents } from "./tex-alert.mjs";

/** What each bridge alert means, in the issue. */
const MEANING = {
  chat_held: "chats held behind a failing event for 2 minutes or more",
  event_parked: "events set aside after 5 minutes of failing (their chats moved on)",
  parked_dropped: "set-aside events dropped after a day of failing",
  frontier_stuck: "line frontier stuck 15 minutes or more",
  big_replay: "large catch-ups after a restart",
};

/** The problems in one window of the bridge's log events. Empty when healthy. */
export function lineProblemsIn(events) {
  const alerts = events.filter((e) => e.event === "bridge.alert");
  const counts = new Map();
  for (const e of alerts) counts.set(e.outcome ?? "unknown", (counts.get(e.outcome ?? "unknown") ?? 0) + 1);
  return [...counts].map(([outcome, n]) => `${n} ${MEANING[outcome] ?? `bridge alerts ${code(outcome)}`}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const minutes = Number(process.env.MINUTES ?? 5);
  const events = await readEvents(minutes, "context-photon-bridge");
  const problems = lineProblemsIn(events);
  if (problems.length > 0) {
    console.log(`Tex's iMessage line in the last ${minutes} minutes (${events.length} events read):\n`);
    for (const line of problems) console.log(`- ${line}`);
  }
}
