# A group turn is seen through by a Cloudflare Workflow (Dev2, 2026-10-27)

Decided by Dev2, 2026-10-27, after group texts went unanswered and the turn
that failed was found only by tailing logs.

**What moved.** The chat's Durable Object still accepts messages, asks
decide, chooses the turn and runs it: a turn reads and writes that object's
storage throughout, and a message that lands meanwhile is steered into it
there. What moved to a Workflow (`apps/agent/src/groupTurnWorkflow.ts`, one
instance per turn, named by the turn's id) is the retrying. The workflow asks
the object to answer the turn; when that throws it retries three more times,
from ten seconds with exponential backoff; after the last it asks the object
to tell the chat it couldn't answer. Each turn shows on the Workflows
dashboard with its step, attempts and error. The object starts nothing else
while a turn is handed over, so a chat still answers one turn at a time.

**A retry never repeats what reached the chat.** Each part a handed turn
sends is remembered by turn and position, as the hash of what it was; a
retry skips a part already sent at that position.

**A workflow that will not start is loud, never quiet.** The start is tried
again on the next alarms, three times in all. After that the turn is answered
in the object as before, and `group_turn workflow_unavailable` is logged as an
error, so a broken binding or a Workflows outage shows, and nobody is left
unanswered.

**A turn whose workflow is gone** (no word for two hours, longer than every
attempt can take) is given up on, with the failed line, rather than holding
the chat.

**Rollout.** Every group at once, tested in production, since group chats are
still in beta. The fallback is reverting the change. 1:1 chats are unchanged.

What a simplification would cost: answering a handed turn without the
per-turn part record sends a reply twice whenever a retry follows a partial
send ("a retry sends only what did not reach the chat" in
`groupTurnWorkflow.test.ts` fails); dropping the in-memory guard answers a
turn twice when a retry overlaps its first attempt ("the same turn asked twice
at once is answered once" fails).
