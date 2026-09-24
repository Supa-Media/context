import { check, rpc, call, lacks, succeeded, contextStore, objects } from "./harness.mjs";
import { visibilityTierForGrant } from "../src/session.js";

export async function runOrientVisibilityChecks() {
  // -- orient scoping
  const oPriv = (await call("priv-token", "orient"))?.content?.[0]?.text;
  const oPub = (await call("pub-token", "orient"))?.content?.[0]?.text;
  check("private orient has private manifest", oPriv?.includes("PRIVATE manifest"));
  // Was: asserts orient tells agents to keep a ledger under `2-areas/agent-todos/`.
  // That is one customer's house rule, and this gateway serves buckets organized
  // years before it existed. The contract now points at their own front page for
  // conventions, which is where a ledger rule actually belongs — and `orient`
  // returns that front page directly above it.
  check(
    "orient defers to the context's own conventions rather than inventing filing",
    oPriv?.includes("Follow their conventions, not a template") &&
      lacks(oPriv, "Read your weekly file")
  );
  check("team orient lacks private manifest", lacks(oPub, "PRIVATE manifest"));
  check("team orient lacks secret project", lacks(oPub, "secret-thing"));
  check("team orient shows team project", oPub?.includes("1-projects/togather"));
  check("team orient hides 1:1 subfolder", lacks(oPub, "one-on-ones"));
  check("orient hides .obsidian", lacks(oPub, ".obsidian") && lacks(oPriv, ".obsidian"));

  // -- orient is the front door, so it has to be worth walking through
  //
  // The complaint these checks exist for is not a privacy bug: it is that a
  // connected agent reads the orientation, learns nothing it can act on, and
  // never comes back. So orient owes the caller three things beyond a folder
  // list — the user's own front page, what they touched recently, and a reason
  // to write anything back.
  check("orient names the front page", oPriv?.includes("## Front page — index.md"));
  check("orient carries the front page content", oPriv?.includes("# public manifest"));
  check("orient surfaces recent activity", oPriv?.includes("## Recently updated"));
  check(
    "orient dates recent activity relatively",
    /## Recently updated\n(?:- \S+\.md — (?:just now|\d+(?:m|h|d|w|mo|y) ago)\n)+/.test(oPriv)
  );
  check("orient asks the agent to write back", oPriv?.includes("Leave more than you took"));
  check(
    "orient points at the next call rather than ending",
    oPriv?.includes("list_notes") && oPriv?.includes("search_notes")
  );

  // A count that included notes the caller cannot see would let a colleague
  // subtract and derive exactly how much of the owner's context is being withheld
  // from them — an exact private-note total handed to the person it was withheld
  // from. So the numbers are derived from the same visibility filter as the
  // listing, and asserted against `list_notes` rather than against a literal,
  // so seeding another fixture below cannot quietly make this vacuous.
  function orientFolderCount(text, prefix) {
    // `text` comes from a call result this file now guards, so it can be
    // undefined where it previously could not. The use is an argument rather
    // than a dereference, which is why no sweep for `oPriv.` or `oPriv?.` finds
    // it — the crash moved here when the assignment stopped throwing.
    if (typeof text !== "string") return null;
    const line = text.match(new RegExp(`^- ${prefix} — (\\d+)(\\+?) notes?$`, "m"));
    return line ? { count: Number(line[1]), floor: line[2] === "+" } : null;
  }
  /**
   * How many notes this connection can list under `prefix`, or `null` if the
   * listing never arrived.
   *
   * `null` rather than `undefined` on purpose, and it is the third shape of the
   * same bug. Neither `succeeded()` nor `lacks()` reaches an EQUALITY whose two
   * operands can both go absent independently: the callers below compare this
   * against `orientFolderCount(...)?.count`, and `undefined === undefined` is
   * `true`. Both counts vanishing is exactly the state where the two checks
   * asserting a team connection counts less than the owner would report PASS
   * having measured nothing on either side — and those are the named owners of
   * the property that stops a colleague deriving an exact private-note total.
   *
   * An empty listing is a real `0` and must stay distinguishable from that.
   */
  async function visibleNoteCount(tokenLabel, prefix) {
    const listed = (await call(tokenLabel, "list_notes", { prefix }))?.content?.[0]?.text;
    if (typeof listed !== "string") return null;
    return listed === "(no visible notes under that prefix)" ? 0 : listed.split("\n").length;
  }
  const projectsPriv = orientFolderCount(oPriv, "1-projects/");
  const projectsPub = orientFolderCount(oPub, "1-projects/");
  check(
    "orient counts notes per folder",
    projectsPriv !== null && projectsPub !== null && !projectsPriv.floor && !projectsPub.floor
  );
  check(
    "orient counts only what the owner can see",
    typeof projectsPriv?.count === "number" &&
      projectsPriv.count === (await visibleNoteCount("priv-token", "1-projects"))
  );
  check(
    "orient counts only what a team connection can see",
    typeof projectsPub?.count === "number" &&
      projectsPub.count === (await visibleNoteCount("pub-token", "1-projects"))
  );
  check(
    "orient's team count is smaller than the owner's",
    projectsPub?.count < projectsPriv?.count
  );
  // Split first, then assert through `lacks`. Written inline the chain reads
  // `!oPub?.split(...)[0].includes(x)`, and optional chaining short-circuits the
  // WHOLE chain to undefined — so on a failed orient the negation is true twice
  // and the check passes without an orientation existing.
  const pubRecentActivity =
    typeof oPub === "string" ? oPub.split("## Structure")[0] : undefined;
  check(
    "orient's recent activity never names a private note",
    lacks(pubRecentActivity, "secret-thing") && lacks(pubRecentActivity, "one-on-ones")
  );
  check(
    "orient omits the floor caveat when nothing was truncated",
    lacks(oPriv, "are floors")
  );

  // -- the ChatGPT dialect: search and fetch
  //
  // Outside developer mode, ChatGPT's chats can invoke exactly two tools on a
  // custom connector — ones literally named `search` and `fetch`, in OpenAI's
  // deep-research shape. Verified live before these existed: asked "who is my
  // sister?", ChatGPT ranked Gmail and Contacts as the plausible sources and
  // never considered this connector, because none of its tools were reachable.
  // These are the same read capabilities as search_notes and read_note, so the
  // checks that matter are that the shape parses and that the dialect discloses
  // nothing the ordinary tools would not.
  const openaiSearch = JSON.parse(
    (await call("priv-token", "search", { query: "togather" }))?.content?.[0]?.text
  );
  check(
    "search answers OpenAI's shape: a results array of id/title/text/url",
    Array.isArray(openaiSearch.results) &&
      openaiSearch.results.length > 0 &&
      openaiSearch.results.every(
        (r) =>
          typeof r.id === "string" &&
          typeof r.title === "string" &&
          typeof r.text === "string" &&
          typeof r.url === "string"
      )
  );
  check(
    "a result id round-trips through fetch",
    await (async () => {
      const fetched = JSON.parse(
        (await call("priv-token", "fetch", { id: openaiSearch.results[0].id }))?.content?.[0]?.text
      );
      return (
        fetched.id === openaiSearch.results[0].id &&
        typeof fetched.text === "string" &&
        fetched.text.length > 0 &&
        typeof fetched.metadata?.etag === "string"
      );
    })()
  );
  // The privacy checks, which are the reason this is not just a formatter: a
  // team connection's search must not surface a private note, and fetch of a
  // private path must be byte-identical to fetching a path that never existed.
  const teamSearch = JSON.parse(
    (await call("pub-token", "search", { query: "PRIVATEWORD" }))?.content?.[0]?.text
  );
  check("a team search cannot surface a private note", teamSearch.results.length === 0);
  const teamFetchPrivate = await call("pub-token", "fetch", { id: "1-projects/secret-thing/status.md" });
  const teamFetchMissing = await call("pub-token", "fetch", { id: "1-projects/never-existed.md" });
  check(
    "fetch of a private note is indistinguishable from fetch of nothing",
    teamFetchPrivate.isError === true &&
      JSON.stringify(teamFetchPrivate) === JSON.stringify(teamFetchMissing)
  );
  check(
    "fetch refuses plumbing and non-note ids",
    (await call("priv-token", "fetch", { id: "privacy.md" }))?.isError === true &&
      (await call("priv-token", "fetch", { id: ".history/index.md.x.archive.md" }))?.isError === true
  );

  // `.context/recover/` is new, and what it holds is the owner's copy of their
  // own access map — the one file where "unreadable to every client" matters most.
  // It is covered by the same dot-segment rule as everything else, which is the
  // argument for putting it there; this is the check that the argument holds,
  // at the owner's own scope and through every reader.
  await contextStore.put(".context/recover/privacy.md.2026-01-01T00-00-00-000Z.md", "# manifest\n");
  check(
    "the recovered manifest copy is unreadable to every client, owner included",
    (await call("priv-token", "fetch", { id: ".context/recover/privacy.md.2026-01-01T00-00-00-000Z.md" }))
      ?.isError === true &&
      (await call("priv-token", "read_note", {
        path: ".context/recover/privacy.md.2026-01-01T00-00-00-000Z.md",
      }))?.isError === true &&
      (await call("priv-token", "write_note", {
        path: ".context/recover/forged.md",
        content: "x",
      }))?.isError === true
  );
  check(
    "the dialect is read-only, so a read-only grant keeps it",
    (await rpc("readonly-token", "tools/list"))?.result?.tools?.some((t) => t.name === "search") === true &&
      succeeded(await call("readonly-token", "search", { query: "togather" }))
  );

  // -- the privacy tier is a property of the grant, not of the approver's role
  //
  // `owner-team-token` and `priv-token` are the SAME PERSON, the same role, the
  // same workspace and the same bucket. They differ in one scope. Everything
  // below is that one scope doing its job, in both directions — because a control
  // that only ever narrows for the wrong reason (a broken token, a missing
  // binding) is not a control, it is an outage.
  //
  // This is also the migration test. A grant issued before the tier existed looks
  // exactly like `owner-team-token`: an owner, read and write, no
  // `context:private`. It must read as `team`, because the alternative — reading
  // an unmarked grant as private — leaves every grant that predates this feature
  // at full access forever, on exactly the grants nobody was ever asked about.
  const ownerTeamPrivateRead = await call("owner-team-token", "read_note", {
    path: "1-projects/secret-thing/status.md",
  });
  check(
    "an owner who granted team-tier cannot read their own private note",
    ownerTeamPrivateRead.isError === true &&
      ownerTeamPrivateRead.content[0].text === "not found" &&
      !JSON.stringify(ownerTeamPrivateRead).includes("PRIVATEWORD")
  );
  const ownerTeamSearch = await call("owner-team-token", "search_notes", { query: "PRIVATEWORD" });
  check(
    "and cannot find it by searching for its contents",
    !JSON.stringify(ownerTeamSearch).includes("secret-thing")
  );
  const ownerTeamOrient = (await call("owner-team-token", "orient"))?.content?.[0]?.text;
  check(
    "and is not shown the private manifest their private-tier client sees",
    lacks(ownerTeamOrient, "PRIVATE manifest") && lacks(ownerTeamOrient, "secret-thing")
  );
  // The other direction, so the three checks above are proving a tier and not a
  // broken grant: the same token reads team content perfectly well, and the same
  // note is readable by the same person's private-tier client.
  const ownerTeamTeamRead = await call("owner-team-token", "read_note", {
    path: "1-projects/togather/status.md",
  });
  check(
    "the same team-tier grant still reads team notes normally",
    !ownerTeamTeamRead.isError && ownerTeamTeamRead.content[0].text.includes("togather status")
  );
  const ownerPrivateRead = await call("priv-token", "read_note", {
    path: "1-projects/secret-thing/status.md",
  });
  check(
    "and their private-tier client reads the very note the team-tier one cannot",
    !ownerPrivateRead.isError && ownerPrivateRead.content[0].text.includes("PRIVATEWORD")
  );

  // The role clamp, from the other side. This grant carries `context:private`
  // because the control plane was compromised or confused — it refuses to write
  // one, in two independent places — and the gateway still will not honour it.
  const memberAskedPrivate = await call("member-asked-private-token", "read_note", {
    path: "1-projects/secret-thing/status.md",
  });
  check(
    "a member's grant carrying the tier scope is still refused private notes",
    memberAskedPrivate.isError === true && memberAskedPrivate.content[0].text === "not found"
  );
  // Same grant, same request, `context:write` in its scopes: a member is
  // read-only in the workspace model, so the grant cannot confer writing either.
  const memberAskedWrite = await call("member-asked-private-token", "write_note", {
    path: "1-projects/member-should-not-write.md",
    content: "no",
  });
  check(
    "and is still refused writing, whatever its scopes say",
    memberAskedWrite.isError === true &&
      memberAskedWrite.content[0].text.includes("permission denied") &&
      objects.has("1-projects/member-should-not-write.md") === false
  );

  // A narrowed scope set is enforced where it counts, not merely displayed. This
  // owner ticked read and left write unticked; being the owner does not put it
  // back.
  const readonlyWrite = await call("readonly-token", "write_note", {
    path: "1-projects/readonly-should-not-write.md",
    content: "no",
  });
  check(
    "an owner's read-only grant cannot write, on the legacy path too",
    readonlyWrite.isError === true &&
      readonlyWrite.content[0].text.includes("permission denied") &&
      objects.has("1-projects/readonly-should-not-write.md") === false
  );
  check(
    "the tier is read off the grant and clamped by role, in one function",
    visibilityTierForGrant(["context:read", "context:private"], "owner") === "private" &&
      visibilityTierForGrant(["context:read"], "owner") === "team" &&
      visibilityTierForGrant([], "owner") === "team" &&
      visibilityTierForGrant(["context:read", "context:private"], "editor") === "team" &&
      visibilityTierForGrant(["context:read", "context:private"], "member") === "team"
  );
  check("orient exposes team write surface", oPub?.includes("Team-writable folder defaults") && oPub?.includes("2-areas"));
  check(
    "orient identifies shared credentials as team access",
    /connection (?:scope|access): team/i.test(oPub) &&
      !/connection (?:scope|access): public/i.test(oPub) &&
      !/writable public prefixes/i.test(oPub)
  );
  const publicScopeInfo = (await call("pub-token", "scope_info"))?.content?.[0]?.text;
  const privateScopeInfo = (await call("priv-token", "scope_info"))?.content?.[0]?.text;
  check("team scope_info lists broad team PARA roots", publicScopeInfo?.includes("1-projects") && publicScopeInfo?.includes("2-areas") && publicScopeInfo?.includes("3-resources") && publicScopeInfo?.includes("4-archive"));
  check("team scope_info hides private override names", lacks(publicScopeInfo, "one-on-ones"));
  check("private scope_info can audit private overrides", privateScopeInfo?.includes("one-on-ones"));


}
