/**
 * COMMENTS ON A NOTE — `packages/shared/src/comments.cjs` (the format) and
 * `write_note`'s `comment` argument (`src/tools/notes/comment.js`).
 *
 * Comments live in the note's own file: an anchor of two HTML comments around
 * the words, and an append-only `comments` block at the end. The checks below
 * are about the three ways that goes wrong:
 *
 *  1. **The file stops being the user's.** Lines the parser does not know are
 *     never rewritten, a comment can never close the block early, and a note
 *     with no comments is byte-identical after `stripComments`.
 *  2. **History is lost.** Resolving adds a line and removes nothing.
 *  3. **Somebody is impersonated or reaches what they could not.** The author
 *     is the connection's client name and there is no argument for it; a
 *     read-only connection cannot comment; a note a connection cannot read is
 *     "not found" exactly as `read_note` says it.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines here.
 *
 *   continuation indent cut from four spaces to two (fence closes early)    2
 *   `sanitizeAuthor` stops removing ":"                                     1
 *   `appendEvent` replaces the thread's last line instead of inserting      4
 *   `comment.js` takes `comment.author` when present                        0
 *     (the schema's additionalProperties refuses the argument first; with
 *     that also removed                                                    3)
 *   dispatch sends `comment` to `toolWriteNote` instead                     8
 */

import comments from "../../../packages/shared/src/comments.cjs";
import { commentAuthor } from "../src/tools/notes/comment.js";

const { addThread, appendEvent, applyChanges, deleteComment, findAnchors, locateQuote, parseComments, sanitizeAuthor, stripComments, describeComments } = comments;

const AT = "2026-09-27T07:30:12Z";

const DEMO = [
  "---",
  "title: pricing",
  "---",
  "",
  "# <!--c:k7f2-->free, you cheapo<!--/c:k7f2--> :annoyed:",
  "",
  "Premium is like 5 bucks doe for early users.",
  "",
  "```comments",
  'k7f2 "free, you cheapo"',
  "- 2026-09-27T07:30:12Z Codex: This seems a little unprofessional. Maybe tone it down.",
  "- 2026-09-27T07:31:40Z @dev2: eh, I don't really care",
  "- 2026-09-27T07:31:45Z @dev2 resolved",
  "```",
  "",
].join("\n");

function sequence(...values) {
  let i = 0;
  return () => values[i++ % values.length];
}

export function runCommentFormatChecks(check) {
  /*
    AN AGENT'S NAME MAY NEVER READ AS A PERSON'S.

    The console tells the two apart by the `@` alone (`comments/model.ts`:
    `isPerson = author.startsWith("@")`), drawing a person's circle and no
    "agent" tag. The gateway signs an agent with its connection's **client
    name**, and that name is client-asserted: RFC 7591 registration is
    unauthenticated by construction (`adminFns/census.ts` says so), so a client
    can call itself anything — including somebody's handle.
  */
  {
    check(
      "comments: an agent whose client name is a handle is not signed as one",
      !commentAuthor({ client: "@dev2" }).startsWith("@"),
    );
    check(
      "comments: …and the name it is signed with still says who it was",
      commentAuthor({ client: "@dev2" }).includes("dev2"),
    );
    check(
      "comments: an ordinary client name is untouched",
      commentAuthor({ client: "Codex" }) === "Codex",
    );
    check(
      "comments: a client name of nothing but an @ is still an agent",
      !commentAuthor({ client: "@" }).startsWith("@") && commentAuthor({ client: "@" }).length > 0,
    );
    check(
      "comments: a person's own handle is written by the console, not through here",
      commentAuthor({ name: "Dev2" }) === "Dev2's agent",
    );
  }

  // --- reading the format ---------------------------------------------------
  {
    const parsed = parseComments(DEMO);
    const thread = parsed.threads[0];
    check("comments: the demo block reads as one thread", parsed.threads.length === 1 && thread.id === "k7f2");
    check("comments: the quote is read from its JSON string", thread.quote === "free, you cheapo");
    check(
      "comments: every line of the log is an event, in order",
      thread.events.map((e) => e.kind).join(",") === "comment,comment,resolved" &&
        thread.events[0].author === "Codex" &&
        thread.events[1].text === "eh, I don't really care",
    );
    check("comments: the last resolve decides the status", thread.status === "resolved");
    check("comments: an anchor with both markers is anchored", thread.anchored === true);
    const range = parsed.anchors.get("k7f2");
    check("comments: the anchor spans exactly the words", DEMO.slice(range.from, range.to) === "free, you cheapo");
  }

  // --- a note with no comments is untouched ----------------------------------
  {
    const plain = "# Title\n\nSome text with <!-- an ordinary comment --> in it.\n\n```js\nconst a = 1;\n```\n";
    check("comments: a note without comments has none", parseComments(plain).threads.length === 0);
    check("comments: stripping a note without comments changes nothing", stripComments(plain) === plain);
    check("comments: read_note says nothing about a note without comments", describeComments(plain) === null);
  }

  // --- starting a thread -----------------------------------------------------
  {
    const note = "# Pricing\n\nfree, you cheapo\n";
    const added = addThread(note, { quote: "you cheapo", author: "Codex", body: "Tone it down.", at: AT, random: sequence(0.5, 0.1, 0.2, 0.3) });
    const next = applyChanges(note, added.changes);
    check("comments: add wraps the quoted words in markers", next.includes(`free, <!--c:${added.id}-->you cheapo<!--/c:${added.id}-->`));
    check(
      "comments: the first thread creates the block at the end, after a blank line",
      next.endsWith(`free, <!--c:${added.id}-->you cheapo<!--/c:${added.id}-->\n\n\`\`\`comments\n${added.id} "you cheapo"\n- ${AT} Codex: Tone it down.\n\`\`\`\n`),
    );
    const again = addThread(next, { quote: "Pricing", author: "@dev2", body: "Title case?", at: AT });
    const twice = applyChanges(next, again.changes);
    const parsed = parseComments(twice);
    check("comments: a second thread joins the same block", parsed.threads.length === 2 && parsed.threads[1].id === again.id);
    check("comments: threads are separated by a blank line", twice.includes(`Tone it down.\n\n${again.id} "Pricing"`));
    check("comments: ids are unique within a note", again.id !== added.id);
    // Overlap: the second anchor starts inside the first.
    const overlap = addThread(next, { quote: "cheapo", author: "Codex", body: "and this", at: AT });
    const overlapped = applyChanges(next, overlap.changes);
    const anchors = parseComments(overlapped).anchors;
    check(
      "comments: anchors may overlap, matched by id rather than nesting",
      anchors.size === 2 && stripComments(overlapped).startsWith("# Pricing\n\nfree, you cheapo"),
    );
  }

  // --- where a comment may not go --------------------------------------------
  {
    const note = "---\ntitle: plan\n---\n\nplan once\n\n```\nplan in code\n```\n\nplan twice and `plan` inline\n";
    check("comments: frontmatter is not commentable", locateQuote(note, "title: plan").error !== undefined);
    check("comments: a code block is not commentable", locateQuote(note, "plan in code").error !== undefined);
    const ambiguous = locateQuote(note, "plan");
    check("comments: an ambiguous quote is refused and counted", /appears 2 times/.test(ambiguous.error ?? ""));
    const second = locateQuote(note, "plan", 2);
    check("comments: occurrence picks the copy", note.slice(second.from, second.to) === "plan" && note.slice(second.from).startsWith("plan twice"));
    check("comments: an occurrence out of range is refused", locateQuote(note, "plan", 3).error !== undefined);
    check("comments: a quote carrying markers is refused", locateQuote(note, "<!--c:abcd-->").error !== undefined);
    // A quote that runs across an existing marker still matches what a reader sees.
    const marked = "say <!--c:abcd-->hello<!--/c:abcd--> world\n";
    const across = locateQuote(marked, "hello world");
    check("comments: a quote spanning an existing anchor is found by what a reader sees", !across.error && marked.slice(across.from, across.to) === "hello<!--/c:abcd--> world");
  }

  // --- replying, resolving, reopening: append-only ----------------------------
  {
    const reply = appendEvent(DEMO, { thread: "k7f2", kind: "comment", author: "Claude", body: "Fair.\n```\nnot a fence\n```", at: AT });
    const replied = applyChanges(DEMO, reply.changes);
    const thread = parseComments(replied).threads[0];
    check(
      "comments: a reply appends and keeps every earlier line",
      replied.includes("- 2026-09-27T07:31:45Z @dev2 resolved\n- 2026-09-27T07:30:12Z Claude: Fair.\n    ```\n    not a fence\n    ```\n```\n"),
    );
    check("comments: a multi-line reply containing a fence cannot close the block", thread.events.length === 4 && thread.events[3].text === "Fair.\n```\nnot a fence\n```");
    check("comments: resolving a resolved thread is refused", /already resolved/.test(appendEvent(DEMO, { thread: "k7f2", kind: "resolved", author: "X", at: AT }).error ?? ""));
    const reopened = applyChanges(DEMO, appendEvent(DEMO, { thread: "k7f2", kind: "reopened", author: "@dev2", at: AT }).changes);
    const after = parseComments(reopened).threads[0];
    check("comments: reopening adds a line and the thread is open again", after.status === "open" && after.events.length === 4);
    check("comments: an unknown thread is refused", appendEvent(DEMO, { thread: "zzzz", kind: "comment", author: "X", body: "hi" }).error !== undefined);
  }

  // --- deleting: the one edit that removes -----------------------------------
  {
    const note = "# Pricing\n\nfree, you cheapo\n";
    const first = addThread(note, { quote: "you cheapo", author: "Codex", body: "Tone it down.", at: AT, id: "aaaa" });
    const one = applyChanges(note, first.changes);
    const gone = applyChanges(one, deleteComment(one, { thread: "aaaa", index: 0 }).changes);
    check("comments: deleting the only thread gives back the note exactly as it was", gone === note);

    const second = applyChanges(one, addThread(one, { quote: "Pricing", author: "@dev2", body: "Title case?", at: AT, id: "bbbb" }).changes);
    const third = applyChanges(second, appendEvent(second, { thread: "aaaa", kind: "comment", author: "@dev2", body: "fine\nreally", at: AT }).changes);
    const withReply = applyChanges(third, appendEvent(third, { thread: "aaaa", kind: "resolved", author: "@dev2", at: AT }).changes);

    const noReply = applyChanges(withReply, deleteComment(withReply, { thread: "aaaa", index: 1 }).changes);
    const kept = parseComments(noReply).threads.find((t) => t.id === "aaaa");
    check(
      "comments: deleting a reply removes its lines, continuation included, and nothing else",
      kept.events.map((e) => e.kind).join(",") === "comment,resolved" && !noReply.includes("really") && noReply.includes("Title case?") &&
        noReply === withReply.replace(`- ${AT} @dev2: fine\n    really\n`, ""),
    );

    const firstGone = applyChanges(withReply, deleteComment(withReply, { thread: "aaaa", index: 0 }).changes);
    const left = parseComments(firstGone);
    check("comments: deleting a thread's first comment deletes the thread and its replies", left.threads.length === 1 && left.threads[0].id === "bbbb" && !firstGone.includes("fine"));
    check("comments: …and its markers, leaving the words", firstGone.includes("\nfree, you cheapo\n") && !firstGone.includes("c:aaaa"));
    check("comments: …and the other thread's anchor is untouched", left.anchors.has("bbbb"));
    check("comments: no blank line is left where the thread was", firstGone.includes("```comments\nbbbb ") && !/\n\n```\n$/.test(firstGone));

    const lastGone = applyChanges(withReply, deleteComment(withReply, { thread: "bbbb", index: 0 }).changes);
    check(
      "comments: deleting the last thread in the block drops the blank line before it",
      /really\n- \S+ @dev2 resolved\n```\n$/.test(lastGone) && parseComments(lastGone).threads.length === 1,
    );

    check("comments: deleting from an unknown thread is refused", deleteComment(withReply, { thread: "zzzz", index: 0 }).error !== undefined);
    check("comments: an index past the thread's comments is refused", deleteComment(withReply, { thread: "aaaa", index: 2 }).error !== undefined);
    check(
      "comments: a comment that is not the one the reader saw is refused",
      /changed/.test(deleteComment(withReply, { thread: "aaaa", index: 1, expect: { at: AT, author: "Codex" } }).error ?? ""),
    );
    const edited = withReply.replace("- " + AT + " @dev2 resolved", "- " + AT + " @dev2 resolved\nnote to self: ask Sayo");
    const handKept = applyChanges(edited, deleteComment(edited, { thread: "aaaa", index: 1 }).changes);
    check("comments: deleting keeps a hand-typed line inside the thread", handKept.includes("note to self: ask Sayo\n"));
  }

  // --- lines somebody typed by hand survive ----------------------------------
  {
    const edited = DEMO.replace("- 2026-09-27T07:31:45Z @dev2 resolved", "- 2026-09-27T07:31:45Z @dev2 resolved\nnote to self: ask Sayo");
    const next = applyChanges(edited, appendEvent(edited, { thread: "k7f2", kind: "reopened", author: "@dev2", at: AT }).changes);
    check("comments: a hand-typed line inside the block is kept verbatim", next.includes("note to self: ask Sayo\n"));
  }

  // --- authors ----------------------------------------------------------------
  {
    check("comments: an author cannot carry a colon", sanitizeAuthor("Evil: injected") === "Evil injected");
    check("comments: an author cannot span lines", !sanitizeAuthor("a\nb c").includes("\n"));
    const sly = applyChanges(DEMO, appendEvent(DEMO, { thread: "k7f2", kind: "reopened", author: "Mallory resolved", at: AT }).changes);
    check("comments: an author named like a status word cannot resolve a thread", parseComments(sly).threads[0].status === "open");
  }

  // --- publishing strips everything ------------------------------------------
  {
    const stripped = stripComments(DEMO);
    check("comments: stripping removes the markers", stripped.includes("# free, you cheapo :annoyed:"));
    check("comments: stripping removes the block and its log", !stripped.includes("unprofessional") && !stripped.includes("```comments"));
    check("comments: stripping keeps the rest of the note", stripped.endsWith("Premium is like 5 bucks doe for early users.\n"));
  }

  // --- a marker shown in a code sample is text, not an anchor ------------------
  {
    const sample = "Anchors look like this:\n\n```html\n<!--c:abcd-->words<!--/c:abcd-->\n```\n";
    check("comments: a marker inside a code block is not an anchor", findAnchors(sample).size === 0);
  }
}

export async function runCommentToolChecks(check, { call, controlPlane, contextStore, storedText, WORKSPACE_ID }) {
  await controlPlane.addGrant({
    accessToken: "cat_test_comments_codex_00000000000",
    workspaceId: WORKSPACE_ID,
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_comments_codex",
    clientName: "Codex",
    userId: "user_colleague",
  });
  await controlPlane.addGrant({
    accessToken: "cat_test_comments_reader_0000000000",
    workspaceId: WORKSPACE_ID,
    role: "member",
    scopes: ["context:read"],
    clientId: "mcp_client_comments_reader",
    clientName: "Reader",
    userId: "user_reader",
  });
  const CODEX = "cat_test_comments_codex_00000000000";
  const READER = "cat_test_comments_reader_0000000000";
  const path = "1-projects/comments/pricing.md";
  await contextStore.put(path, "# free, you cheapo :annoyed:\n\nPremium is like 5 bucks doe.\n");

  const added = await call(CODEX, "write_note", {
    path,
    comment: { action: "add", quote: "free, you cheapo", text: "This seems a little unprofessional. Maybe tone it down." },
  });
  const addedText = added?.content?.[0]?.text ?? "";
  check("comment tool: an agent can start a thread", !added?.isError && /comment: started thread [a-z0-9]{4,12} on "free, you cheapo" as Codex/.test(addedText));
  const id = /started thread ([a-z0-9]{4,12})/.exec(addedText)?.[1];
  const stored = await storedText(path);
  check(
    "comment tool: the anchor and the log line are written into the note itself",
    typeof stored === "string" && stored.includes(`# <!--c:${id}-->free, you cheapo<!--/c:${id}--> :annoyed:`) && /- \d{4}-\d\d-\d\dT[\d:]+Z Codex: This seems a little unprofessional/.test(stored),
  );

  const read = await call(CODEX, "read_note", { path });
  check("comment tool: read_note says there is an open comment, with its id", (read?.content?.[0]?.text ?? "").includes(`comments: 1 open (${id} on "free, you cheapo")`));

  const replied = await call("priv-token", "write_note", { path, comment: { action: "reply", thread: id, text: "eh, I don't really care" } });
  check("comment tool: another connection can reply", !replied?.isError);
  const resolved = await call(CODEX, "write_note", { path, comment: { action: "resolve", thread: id } });
  check("comment tool: a thread can be resolved", !resolved?.isError && /resolved thread/.test(resolved?.content?.[0]?.text ?? ""));
  const final = await storedText(path);
  const thread = parseComments(final).threads[0];
  check("comment tool: resolving keeps the whole history", thread?.status === "resolved" && thread.events.length === 3);

  const impersonate = await call(CODEX, "write_note", { path, comment: { action: "reopen", thread: id, author: "@dev2" } });
  check("comment tool: there is no author argument to claim a name with", impersonate?.isError === true || impersonate === undefined);
  check("comment tool: and nothing was written under another name", !(await storedText(path)).includes("@dev2 reopened"));

  const readerTry = await call(READER, "write_note", { path, comment: { action: "reply", thread: id, text: "sneaky" } });
  check("comment tool: a read-only connection cannot comment", readerTry?.isError === true && !(await storedText(path)).includes("sneaky"));

  const hidden = await call(CODEX, "write_note", { path: "1-projects/private/plan.md", comment: { action: "add", quote: "x", text: "y" } });
  const hiddenRead = await call(CODEX, "read_note", { path: "1-projects/private/plan.md" });
  check(
    "comment tool: a note the connection cannot read is not found, in read_note's own words",
    hidden?.isError === true && hidden?.content?.[0]?.text === hiddenRead?.content?.[0]?.text,
  );

  const both = await call(CODEX, "write_note", { path, content: "replace", comment: { action: "resolve", thread: id } });
  check("comment tool: content and comment together are refused", both?.isError === true && (await storedText(path)) === final);

  const withShare = await call(CODEX, "write_note", { path, visibility: "private", comment: { action: "reopen", thread: id } });
  check("comment tool: other arguments beside a comment are refused, not ignored", withShare?.isError === true && (await storedText(path)) === final);

  const notMine = await call(CODEX, "write_note", { path: "1-projects/comments/pricing.md", comment: { action: "delete", thread: id } });
  check("comment tool: an agent's delete takes back its own comment first", !notMine?.isError && /deleted thread/.test(notMine?.content?.[0]?.text ?? ""));
  check("comment tool: deleting the thread it started removes the thread and its anchor", parseComments(await storedText(path)).threads.length === 0 && !(await storedText(path)).includes("<!--c:"));

  const kept = await call(CODEX, "write_note", { path, comment: { action: "add", quote: "free, you cheapo", text: "again" } });
  const keptId = /started thread ([a-z0-9]{4,12})/.exec(kept?.content?.[0]?.text ?? "")?.[1];
  await call("priv-token", "write_note", { path, comment: { action: "reply", thread: keptId, text: "a person's reply" } });
  const before = await storedText(path);
  const priv = await call("priv-token", "write_note", { path, comment: { action: "reply", thread: keptId, text: "and another" } });
  const afterPriv = await storedText(path);
  const codexReply = await call(CODEX, "write_note", { path, comment: { action: "reply", thread: keptId, text: "codex again" } });
  const deletedReply = await call(CODEX, "write_note", { path, comment: { action: "delete", thread: keptId } });
  const afterDelete = await storedText(path);
  check(
    "comment tool: delete removes the agent's latest comment, not the thread, when that was a reply",
    !priv?.isError && !codexReply?.isError && !deletedReply?.isError && afterDelete === afterPriv && before !== afterPriv,
  );
  const theirs = await call("priv-token", "write_note", { path, comment: { action: "add", quote: "Premium", text: "someone else's" } });
  const theirsId = /started thread ([a-z0-9]{4,12})/.exec(theirs?.content?.[0]?.text ?? "")?.[1];
  const beforeRefusal = await storedText(path);
  const refused = await call(CODEX, "write_note", { path, comment: { action: "delete", thread: theirsId } });
  check(
    "comment tool: an agent cannot delete a thread it wrote nothing in",
    refused?.isError === true && /only your own/.test(refused?.content?.[0]?.text ?? "") && (await storedText(path)) === beforeRefusal,
  );
  const otherAgent = await call(READER, "write_note", { path, comment: { action: "delete", thread: keptId } });
  check("comment tool: a read-only connection cannot delete", otherAgent?.isError === true && (await storedText(path)) === beforeRefusal);

  const ambiguous = await call(CODEX, "write_note", { path, comment: { action: "add", quote: "e", text: "which one?" } });
  check("comment tool: an ambiguous quote is refused with a count", ambiguous?.isError === true && /appears \d+ times/.test(ambiguous?.content?.[0]?.text ?? ""));
}
