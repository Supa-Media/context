# The archive has its own search

### Regular search leaves the archive out; a search inside `archive/` is the archive's search

Dev2, 2026-11-23: "archive is supposed to be out of search results I thought?" and "search archive should be separate from regular search". Until then an archived note scored half of a live one with the same evidence (`priors.js` `LOG_PRIOR`, 2026-11-03), so it still showed whenever its words matched.

- **What is left out.** A note under the workspace's archive folder (`topLevelRole` `archive`: `archive/`, `4-archive/`, ...), in any workspace a search reaches, from the word hits and from the notes only meaning found, its count with it (`priors.js` `leftOutOfSearch`, `stages.js` `dropProbes`, `meaning/serve.js`). A folder named "archive" deeper down is not the archive.
- **The archive's search.** A search whose folder (`prefix`) is inside the archive keeps archived notes. The search tool's description says so (prefix archive/), so an AI client knows where to look.
- Logs elsewhere (Inbox communications, Tex's logs, the activity log) are still lowered, not removed.

**Bench.** No case expects an archived note. Embedder faked: search-real dev 5/10 and training 17/30 unchanged, NanoBEIR gate 0.506 unchanged, search-hard 36 → 35 of 41 (one long-note case 1 → 2, from the reciprocal ranks shifting once an archived meaning match is gone; the gate on real embeddings decides).

**What a simplification would cost:** lowering instead of leaving out shows the archive again whenever its words match best. **Tests:** `apps/mcp/test/searchPriors.test.mjs` ("regular search leaves archive out", "a search inside the archive is the archive's own"; each sabotage-checked).
