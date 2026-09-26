/**
 * Auto-organize's engine: which notes a sweep asks about, what it asks, and
 * which answers become suggestions. See `src/organizer/` and
 * docs/decisions/storage-and-credentials/inference.md.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to `src/organizer/`, and reverted.
 *
 * 1. **`doneSuggestion` ignoring `open_steps`** — 1 failed: "open next steps
 *    keep it open".
 * 2. **`archiveSuggestion` without the quiet check** — 1 failed: "a closed
 *    project edited last week is not archived yet".
 * 3. **`planSweep` keeping every inbox depth** — 1 failed: "mail is not
 *    offered for filing".
 * 4. **`resolveSuggestion` not resetting the streak on dismiss** — 1 failed:
 *    "a dismiss resets the streak".
 * 5. **`mergeSweep` forgetting dismissals** — 1 failed: "a dismissed
 *    suggestion does not come back".
 */

import {
  archiveSuggestion,
  doneSuggestion,
  fileSuggestion,
  suggestionId,
} from "../src/organizer/suggest.js";
import { MAX_SWEEP_PROJECTS, organizerRoots, planSweep } from "../src/organizer/plan.js";
import {
  checkboxCounts,
  inboxRequest,
  projectFacts,
  projectRequest,
  spokenSpan,
} from "../src/organizer/questions.js";
import {
  ORGANIZER_STATE_KEY,
  emptyOrganizerState,
  rememberRevert,
  mergeSweep,
  parseOrganizerState,
  readOrganizerState,
  resolveSuggestion,
  writeOrganizerState,
} from "../src/organizer/state.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 26);

const entry = (path, daysAgo) => ({ path, updatedAt: NOW - daysAgo * DAY, etag: `e-${path}` });

const ENTRIES = [
  entry("0-inbox/cloudflare-saas-hostname-notes.md", 1),
  entry("0-inbox/meetings/2026-09-25-website-review.md", 1),
  entry("0-inbox/email/gmail/2026-09-25.md", 1),
  entry("0-inbox/sessions/claude/x.md", 1),
  entry("1-projects/custom-domains/overview.md", 3),
  entry("1-projects/custom-domains/cloudflare-handoff.md", 2),
  entry("1-projects/intake-incident.md", 2),
  entry("1-projects/no-front/notes.md", 5),
  entry("2-areas/apps/context/log.md", 1),
  entry("3-resources/books/one.md", 40),
  entry("4-archive/1-projects/old/overview.md", 400),
  entry(".context/organizer/state.json", 0),
  entry("index.md", 0),
];

const doneAnswers = (overrides = {}) => ({
  stage: { type: "choice", choice: "done", confidence: 0.8, probabilities: { done: 0.85 } },
  shipped: { type: "noul", noul: 0.9 },
  open_steps: { type: "noul", noul: 0.1 },
  ...overrides,
});

function memoryStore() {
  const objects = new Map();
  let version = 0;
  return {
    objects,
    async get(key) {
      const found = objects.get(key);
      if (!found) return null;
      return { etag: found.etag, text: async () => found.text, arrayBuffer: async () => new TextEncoder().encode(found.text).buffer };
    },
    async put(key, text, options = {}) {
      const found = objects.get(key);
      if (options.onlyIf?.absent && found) return null;
      if (options.onlyIf?.etagMatches && found?.etag !== options.onlyIf.etagMatches) return null;
      const etag = `v${++version}`;
      objects.set(key, { text, etag });
      return { etag };
    },
  };
}

export async function runOrganizerChecks(check) {
  // ── Planning ────────────────────────────────────────────────────────────
  const roots = organizerRoots(ENTRIES.map((e) => e.path));
  check("PARA roots are recognised by shape", roots.inbox === "0-inbox" && roots.projects === "1-projects" && roots.areas === "2-areas" && roots.resources === "3-resources" && roots.archive === "4-archive");
  check("a context with no projects folder has none", organizerRoots(["notes/a.md", "b.md"]).projects === null);

  const plan = planSweep(ENTRIES, NOW);
  const projectPaths = plan.projects.map((p) => p.path);
  check("a folder with a front note is a project", projectPaths.includes("1-projects/custom-domains"));
  check("a note in the projects folder is a project", projectPaths.includes("1-projects/intake-incident.md"));
  check("a folder with no front note is not", !projectPaths.includes("1-projects/no-front"));
  const domains = plan.projects.find((p) => p.path === "1-projects/custom-domains");
  check("a folder project's last save is its newest file", domains?.updatedAt === NOW - 2 * DAY && domains.frontPath === "1-projects/custom-domains/overview.md");
  const inboxPaths = plan.inbox.map((n) => n.path);
  check("loose inbox notes and inbox meetings are offered for filing", inboxPaths.includes("0-inbox/cloudflare-saas-hostname-notes.md") && inboxPaths.includes("0-inbox/meetings/2026-09-25-website-review.md"));
  check("mail is not offered for filing", !inboxPaths.some((p) => p.includes("/email/") || p.includes("/sessions/")));
  check("plumbing and the front page are never planned", ![...projectPaths, ...inboxPaths].some((p) => p.startsWith(".context") || p === "index.md"));
  const destinationPaths = plan.destinations.map((d) => d.path);
  check("destinations are project, area and resource folders", destinationPaths.join() === "1-projects/custom-domains,2-areas/apps,3-resources/books");
  check("the archive is never a destination", !destinationPaths.some((p) => p.startsWith("4-archive")));

  const many = Array.from({ length: MAX_SWEEP_PROJECTS + 10 }, (_, i) => entry(`1-projects/p${i}.md`, i));
  check("a sweep asks about a bounded number of projects", planSweep(many, NOW).projects.length === MAX_SWEEP_PROJECTS);

  // ── Facts and questions ─────────────────────────────────────────────────
  check("checkboxes are counted outside code fences", JSON.stringify(checkboxCounts("- [x] a\n- [ ] b\n* [X] c\n```\n- [ ] not me\n```\n")) === JSON.stringify({ done: 2, open: 1 }));
  check("spans read the way people say them", spokenSpan(21) === "3 weeks" && spokenSpan(3) === "3 days" && spokenSpan(90) === "3 months");

  const incident = plan.projects.find((p) => p.path === "1-projects/intake-incident.md");
  const incidentText = "---\nstatus: fix-in-review\n---\n# Client intake publishing incident\n\nFix: PR #908, merged.\n";
  const facts = projectFacts(incident, incidentText, NOW);
  check("facts read the status and title from the note", facts.status === "fix-in-review" && !facts.closed && facts.title === "Client intake publishing incident");
  const request = projectRequest(incident, incidentText, facts);
  check("the state carries computed facts as sentences", /status field says "fix-in-review"/.test(request.state) && /changed for 2 days/.test(request.state));
  check("every project choice has a way out", "unclear" in request.questions.stage.criteria);
  check("the question names are ones the worker accepts", Object.keys(request.questions).every((n) => /^[a-z][a-z0-9_]{0,39}$/.test(n)));
  const long = projectRequest(incident, "x".repeat(50_000), facts);
  check("a long note is cut before it reaches Jev", long.state.length < 20_000);

  const inboxReq = inboxRequest(plan.inbox[0], "# Hostname notes\n\nCNAME for custom domains", plan.destinations);
  check("an inbox note may always stay", inboxReq.questions.destination.criteria.stay !== undefined);
  check("each destination is one option", Object.keys(inboxReq.questions.destination.criteria).length === plan.destinations.length + 1);

  // ── Suggestions ─────────────────────────────────────────────────────────
  const done = doneSuggestion(incident, facts, doneAnswers());
  check("an open project that reads as shipped is suggested done", done?.kind === "done" && done.path === "1-projects/intake-incident.md" && done.status === "fix-in-review" && done.reason === "It says the work shipped");
  check("open next steps keep it open", doneSuggestion(incident, facts, doneAnswers({ open_steps: { type: "noul", noul: 0.7 } })) === null);
  check("Jev reading it as active keeps it open", doneSuggestion(incident, facts, doneAnswers({ stage: { type: "choice", choice: "active", confidence: 0.9, probabilities: {} } })) === null);
  check("done without evidence in the note is not enough", doneSuggestion(incident, facts, doneAnswers({ shipped: { type: "noul", noul: 0.2 } })) === null);
  const ticked = projectFacts(incident, "---\nstatus: active\n---\n- [x] one\n- [x] two\n", NOW);
  check("every step ticked is evidence on its own", doneSuggestion(incident, ticked, doneAnswers({ shipped: { type: "noul", noul: 0.1 } }))?.reason === "Every step is ticked off");
  const optedOut = projectFacts(incident, "---\nstatus: active\norganize: off\n---\n", NOW);
  check("a note that says organize: off is left alone", doneSuggestion(incident, optedOut, doneAnswers()) === null);
  check("a project with no status is not a project", doneSuggestion(incident, projectFacts(incident, "# no status", NOW), doneAnswers()) === null);

  const shipList = { "not-started": [], "in-progress": ["building"], done: ["shipped", "dropped"] };
  const custom = projectFacts(incident, "---\nstatus: building\n---\n", NOW, shipList);
  check("mark done writes the folder's own Done word", doneSuggestion(incident, custom, doneAnswers())?.to === "shipped");
  check("with no list declared it writes the default Done word", doneSuggestion(incident, facts, doneAnswers())?.to === "finished");
  check("a folder's own Done word closes a project", projectFacts(incident, "---\nstatus: dropped\n---\n", NOW, shipList).closed === true);
  const closedOld = projectFacts({ ...domains, updatedAt: NOW - 21 * DAY }, "---\nstatus: done\n---\n", NOW);
  const archive = archiveSuggestion({ ...domains, updatedAt: NOW - 21 * DAY }, closedOld);
  check("a done project quiet for three weeks is suggested for the archive", archive?.kind === "archive" && archive.path === "1-projects/custom-domains" && archive.reason === "Done, and quiet for 3 weeks");
  check("a closed project edited last week is not archived yet", archiveSuggestion(domains, projectFacts(domains, "---\nstatus: done\n---\n", NOW)) === null);
  check("an open project is never suggested for the archive", archiveSuggestion({ ...domains, updatedAt: NOW - 60 * DAY }, projectFacts({ ...domains, updatedAt: NOW - 60 * DAY }, "---\nstatus: active\n---\n", NOW)) === null);

  const note = plan.inbox.find((n) => n.path === "0-inbox/cloudflare-saas-hostname-notes.md");
  const filed = fileSuggestion(note, "Hostname notes", plan.destinations, { destination: { type: "choice", choice: "d0", confidence: 0.8, probabilities: { d0: 0.8, stay: 0.2 } } });
  check("an inbox note is suggested into its best folder", filed?.kind === "file" && filed.target.path === "1-projects/custom-domains" && filed.target.title === "Custom domains");
  check("stay means no suggestion", fileSuggestion(note, "t", plan.destinations, { destination: { type: "choice", choice: "stay", confidence: 0.9, probabilities: { stay: 0.9 } } }) === null);
  check("a weak pick means no suggestion", fileSuggestion(note, "t", plan.destinations, { destination: { type: "choice", choice: "d1", confidence: 0.4, probabilities: { d1: 0.4, stay: 0.35 } } }) === null);
  check("an option that was never offered means no suggestion", fileSuggestion(note, "t", plan.destinations, { destination: { type: "choice", choice: "d99", confidence: 0.9, probabilities: { d99: 0.9 } } }) === null);
  check("ids are stable and differ by target", suggestionId("file", "a.md", "x") === suggestionId("file", "a.md", "x") && suggestionId("file", "a.md", "x") !== suggestionId("file", "a.md", "y"));

  // ── State ───────────────────────────────────────────────────────────────
  check("a malformed state file reads as empty", JSON.stringify(parseOrganizerState("{nope")) === JSON.stringify(emptyOrganizerState()));
  const merged = mergeSweep(emptyOrganizerState(), [done, archive, filed], NOW);
  check("a sweep fills the pending list", merged.pending.length === 3 && merged.sweptAt === NOW);
  const dismissed = resolveSuggestion(merged, archive.id, "dismiss", NOW);
  check("a dismiss takes it off the list", dismissed.state.pending.length === 2 && dismissed.suggestion.id === archive.id);
  const again = mergeSweep(dismissed.state, [done, archive, filed], NOW + DAY);
  check("a dismissed suggestion does not come back", !again.pending.some((s) => s.id === archive.id));
  const later = mergeSweep(dismissed.state, [archive], NOW + 91 * DAY);
  check("…until it has been dismissed for 90 days", later.pending.some((s) => s.id === archive.id));

  let streak = { ...merged, pending: [1, 2, 3, 4].map((n) => ({ ...done, id: `done-${n}`, path: `p${n}.md` })) };
  const offers = [];
  for (const n of [1, 2, 3]) {
    const next = resolveSuggestion(streak, `done-${n}`, "accept", NOW);
    offers.push(next.offer);
    streak = next.state;
  }
  check("the third accept in a row earns the offer, and only the third", offers.join() === "false,false,true");
  check("a dismiss resets the streak", resolveSuggestion(streak, "done-4", "dismiss", NOW).state.streaks.done === 0);
  const remembered = rememberRevert(merged, "p1.md", "fix-in-review");
  check("a status changed without asking is remembered for Undo", parseOrganizerState(JSON.stringify(remembered)).reverts["p1.md"] === "fix-in-review");
  check("…and forgotten once put back", rememberRevert(remembered, "p1.md", undefined).reverts["p1.md"] === undefined);
  check("resolving an unknown id changes nothing", resolveSuggestion(merged, "nope", "accept", NOW).suggestion === null);

  const store = memoryStore();
  const first = await readOrganizerState(store);
  check("no state file reads as empty", first.etag === null && first.state.pending.length === 0);
  const etag = await writeOrganizerState(store, merged, null);
  check("state lives under .context/organizer/", store.objects.has(ORGANIZER_STATE_KEY) && ORGANIZER_STATE_KEY === ".context/organizer/state.json");
  check("a write on a stale etag is refused", (await writeOrganizerState(store, merged, "stale")) === null);
  check("a write on the current etag lands", (await writeOrganizerState(store, merged, etag)) !== null);
}
