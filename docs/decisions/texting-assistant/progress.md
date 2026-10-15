# A long task texts its progress, and may take longer than a question (2026-10-10)

The owner wants to text Tex and have it do real work: browse, fill in forms,
work through many notes. A question is answered in seconds; a task is many
steps, and five silent minutes read as broken. So the texting Worker asks the
gateway for every texted turn as a stream (`Accept: application/x-ndjson`,
`apps/mcp/src/agent/progress.js`), and a streamed texting turn:

- is offered `text_progress`, which texts the person one short line now
  ("Opening ChatGPT now.") and is dispatched in the turn, never to the MCP. It
  reaches only the person who asked, on the channel the answer goes to, so it
  widens nothing. At most 8 a turn, 280 characters each, no repeats;
- may take 30 model rounds and 9 minutes of tool time, against a quick turn's
  8 and 70 seconds; a setup's `max_steps` (now 1 to 40) still only tightens;
- ends with the route's ordinary JSON as the last line, with its status, so
  authority, meter, turn log and history are the route's own. Heartbeats every
  15 seconds keep each hop from idling the stream out.

The Worker texts each line as it arrives with its own idempotency key and does
not retry it with the answer, sends "On it…" once if 40 seconds pass with no
word, and gives up at 12 minutes, inside a Durable Object alarm's 15. A
routine's run never streams: it is unattended and texts once. A tool slow by
nature (a browser step) may name its own time limit (`toolTimeouts`). Tests:
`agentProgress.test.mjs`, `clients.test.ts` "askAgent, streamed",
`inbox.test.ts` "texts a long task's progress as it happens".
