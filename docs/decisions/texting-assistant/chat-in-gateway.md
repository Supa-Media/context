# A chat's object runs in the gateway, moved and not rewritten (Dev2, 2026-11-14)

Step 3 of Tex's config graph, approved by Dev2 on 2026-11-14
(https://claude.ai/artifact/6iF9DnjvN4aGVREhPc6yua): a text arriving,
Triage, Decide, React and the per-chat queues move from the texting Worker
into the gateway, and the Worker keeps checking webhooks, handing texts over
and delivering answers.

**The chat object moves as it is.** The Worker's chat object
(`apps/agent/src/chatObject.ts`, a person's inbox or a group's) imports
nearly the whole Worker: its queue, its alarm, its turns, its lanes, its
pictures and pages. Rewriting it for the gateway would mean two copies of
every rule while the move is under way, with nothing to show the two agree.
So the gateway's `TexChat` (`apps/mcp/src/texChat.js`) runs the same class on
its own storage, and only what the object reaches outside itself changes, all
of it through the `env` it is given:

- the gateway's own routes (`/agent`, ...) and `TexTexts` are called
  in-process, with no HTTP hop (`FETCH`, `GATEWAY_TEXTS`);
- the line (send, typing, read, tapback, group members) stays the Worker's,
  over its `TexRoutines` RPC (`lineCall`, `groupLineCall`,
  `apps/agent/src/lineCalls.ts`, `remoteLine.ts`), because the line's keys
  stay in the Worker;
- the Worker's other objects (a job's, a chat's directory entry) are reached
  by name over the same RPC (`inboxFetch`), and a group turn's retries stay
  the Worker's Workflow (`groupTurn`), until step 4 moves jobs;
- the control plane is reached with the Worker's `AGENT_WORKER_SECRET`, synced
  to the gateway from the same repository secret.

This is the one place the gateway runs TypeScript: Wrangler bundles it, and
the gateway's tests load it with Node's `--experimental-transform-types` and
`apps/mcp/test/tsHook.mjs`. It ends when step 7 moves the files under
`apps/mcp/src/` and deletes the Worker's copy.

**A chat moves once, by copying.** The first text handed over for a chat
copies the Worker's object in with the same copy and digest the Worker's own
moves use (`inboxMove.ts`): the Worker's object marks itself moved to the
gateway and passes every later call to the gateway's copy
(`/texts/chat-call/*`), its alarm included. A copy that fails or finds the
Worker's object busy leaves that object answering, and the hand-over falls
back to it. The copy keeps the id the object had in the Worker, so the
addresses it minted for pictures and pages, and its counts, still name it.

**Which chats come is the Worker's `INTAKE` var**, `worker` on both
deployments until the staging proof; nothing moves while it is.

What a "simplification" would cost: a rewrite of the chat object for the
gateway forks every queue, turn and lane rule in two; calling the line from
the gateway with keys of its own puts line credentials in a second Worker.
Tests: `apps/mcp/test/texChatMove.test.mjs` (a handed-over text is copied in,
queued and answered on the Worker's line; a refused copy leaves the Worker
answering), `apps/agent/src/gatewayMove.test.ts`, `handOver.test.ts`,
`scripts/deploy-plan.test.mjs` (the chat code deploys both Workers).
