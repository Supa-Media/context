# App and console: no chat inside the app

## The console has no chat; people ask the AI they connect

Decided by the owner, 2026-10-10: *"remove chat from the sidebar entirely"*.
The console used to carry a conversation with an in-app agent in several
places — the right panel's Chat tab (the tab it opened on), the `+` menu's New
chat row on both densities, ⌘K's "Ask about…" row, the note's right-click "Ask
about this note", the microphone sheet's "Ask your context" and the phone's Ask
AI key in the note bar — answered through a
model key the person pasted into Settings. All of it is gone, on web, desktop
and phone, together with the client-side engine behind it
(`features/agent/{AgentPanel,AgentConversation,engine,gateway,local,page,…}`).
The model-key setting it depended on goes in the same pass on the Settings side.

What is left in the right panel is what happens *beside* a note and is not a
conversation: Meetings, which it now opens on, and Approvals.

**Why not keep it behind the key.** A second place to ask questions, inside
the app, competed with the product's actual promise — your context in the AI
you already use — and only worked for the few people who had pasted a key.
Asking about a context happens in the Claude, ChatGPT or texting assistant a
person connects; those already read through their own revocable grant.

**What a simplification of this would cost.** Bringing a row back "just on
desktop" or "just where a key exists" is the same feature again; it needs a
decision here first. The checks are `two tabs, Meetings first, and no Chat`
(`asideTabs.test.ts`), `a panel opens on Meetings, and there is no Chat tab`
(`asidePanelRender.test.ts`), `there is no chat row` (`createSheetRows.test.ts`),
`no conversation is offered, even with a model key` and `no chat row on a
phone, even with a model key` (`consoleChrome/phoneDestinations.test.ts`), and
`there is no Ask row, whatever is typed` (`paletteRender/handoffs.test.ts`).

The gateway's `/agent` route and the desktop shell's local-`claude` bridge are
not touched: the texting assistant uses the first, and the second is the
starting point of the "your own AI plan" work.

Earlier records that describe the chat — "New chat is drawn only where the
context has a model key" in [sidebar-tree-and-testing](./sidebar-tree-and-testing.md)
and the phone's chat card in [quick-create-and-activity-feed](./quick-create-and-activity-feed.md) —
are history now; this section supersedes them.
