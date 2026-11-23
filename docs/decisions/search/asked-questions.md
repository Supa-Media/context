# Search asks the index for what a question is about

### The words that only say how a question is asked are left out of the word index's query

Production, 2026-11-23, through the MCP: "what did we decide about bring your own bucket" and "what number do people text tex at now" returned meeting transcripts and archived chats, and the notes that answer them did not appear. The word index's first query needs every word of the question in one chunk. A note that states an answer rarely holds "what", "did" and "we", and a long transcript holds them all, so only transcripts matched, and the any-word retry, which would have found the answer, runs only when nothing matched.

- **What is left out.** `FILLER_WORDS` (`apps/mcp/src/search/text.js`, the three-letter-or-longer words already left out of title evidence) and the one- and two-letter words of a question (`a`, `at`, `do`, `we`, ...: `SHORT_FILLER`, `apps/mcp/src/search/d1/query.js`). A query made only of such words asks all of them, so it still finds something.
- **Where.** The strict, typing and any-word expressions all ask the same words (`tokensOf`), on the search database and on the workspace object alike, since both build their queries there.

**Bench.** search-hard's `asked` kind: three questions asked in a person's words, each beside a meeting transcript that quotes it (`what is the price for the caterer`, `where do we keep the spare key`, `who books the room for the thursday session`). With the embedder faked: search-hard 37 → 38 of 44 (both missing asked questions now first; one paraphrase moves 1 → 2 and another 3 → 2), search-real dev and training unchanged.

**What a simplification would cost:** asking every word again makes a question's "what did we" a requirement, and the notes that hold it are transcripts. **Tests:** `apps/mcp/test/searchD1.test.mjs` (the asked-question block, sabotage-checked: 2 checks fail with filler kept), and search-hard's `asked` cases.
