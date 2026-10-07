import { baseName } from "../console/files/paths";
import type { MapFixtureSource } from "../console/map/live/MapSourceContext";
import type { MapActor } from "../console/map/live/engine";
import type { ActorRef, MapEvent, MapNode, WorkspaceGraph } from "../console/map/live/types";

/**
 * The live map's invented world, for the screenshot fixture alone
 * (`LiveMapFixture.tsx`). Every name is made up — people, tools, notes — and
 * the workspaces are the demo console's own three. Seeded, so two runs draw
 * the same map; times are relative to `now`, so the feed says "now" and the
 * replay's bar ends at the present.
 */

type Workspace = { id: string; slug: string; name: string; kind: "personal" | "shared" };

const FOLDERS = ["0-inbox", "1-projects", "2-areas", "3-resources", "4-archive"] as const;

/** The notes the stills name, by folder, so the busy ones carry readable titles. */
const NAMED: Record<(typeof FOLDERS)[number], string[]> = {
  "0-inbox": ["Idea: referral perks", "Voice memo", "Receipt from Figma"],
  "1-projects": ["Call with Dana", "Pricing", "Onboarding emails", "Q4 goals", "Release checklist", "Launch plan", "Website refresh", "Hiring"],
  "2-areas": ["Brand", "Support rota", "Finance"],
  "3-resources": ["Weekly update", "Style guide", "API changes", "Glossary", "Customer interviews"],
  "4-archive": ["Old pricing", "Summer launch"],
};

const WORDS = [
  "notes", "plan", "review", "draft", "ideas", "agenda", "outline", "summary", "checklist", "brief",
  "budget", "retro", "roadmap", "survey", "metrics", "sync", "proposal", "timeline", "feedback", "design",
];
const TOPICS = [
  "Partner", "Team", "Venue", "Volunteer", "Sprint", "Quarter", "Event", "Newsletter", "Podcast", "Grant",
  "Workshop", "Campaign", "Studio", "Pilot", "Vendor", "Offsite", "Choir", "Rehearsal", "Setlist", "Mentor",
];

/** A small seeded generator (mulberry32), so the map is the same every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slugOf = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function graphFor(ws: Workspace, sizes: Record<(typeof FOLDERS)[number], number>, seed: number, named: boolean): WorkspaceGraph {
  const rand = seeded(seed);
  const nodes: MapNode[] = [];
  const used = new Set<string>();
  const byFolder = new Map<string, number[]>();
  for (const folder of FOLDERS) {
    const titles = named ? [...NAMED[folder]] : [];
    while (titles.length < sizes[folder]) {
      const title = `${TOPICS[Math.floor(rand() * TOPICS.length)]} ${WORDS[Math.floor(rand() * WORDS.length)]}`;
      if (!titles.includes(title)) titles.push(title);
    }
    const indexes: number[] = [];
    for (const title of titles) {
      // A few notes sit one folder deeper, so the map has subfolders to draw.
      const sub = folder === "1-projects" && rand() < 0.3 ? "1-projects/launch/" : folder === "3-resources" && rand() < 0.25 ? "3-resources/guides/" : `${folder}/`;
      const path = `${sub}${slugOf(title)}.md`;
      if (used.has(path)) continue;
      used.add(path);
      indexes.push(nodes.length);
      nodes.push({ path, title });
    }
    byFolder.set(folder, indexes);
  }
  const edges: [number, number][] = [];
  const seen = new Set<string>();
  const link = (a: number, b: number) => {
    if (a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push([a, b]);
  };
  // Mostly within a folder, a hub or two per folder, and some across.
  for (const indexes of byFolder.values()) {
    for (let i = 1; i < indexes.length; i++) {
      link(indexes[i]!, indexes[Math.floor(rand() * i)]!);
      if (rand() < 0.35) link(indexes[i]!, indexes[Math.floor(rand() * indexes.length)]!);
    }
  }
  for (let i = 0; i < nodes.length / 6; i++) link(Math.floor(rand() * nodes.length), Math.floor(rand() * nodes.length));
  return { workspaceId: ws.id, slug: ws.slug, name: ws.name, kind: ws.kind, nodes, edges };
}

const SEYI: Workspace = { id: "seyi", slug: "seyi", name: "Personal", kind: "personal" };
const PW: Workspace = { id: "pw", slug: "public-worship", name: "Public Worship", kind: "shared" };
const LK: Workspace = { id: "lk", slug: "lk", name: "lk", kind: "personal" };

const path = (folder: string, title: string) => `${folder}/${slugOf(title)}.md`;

const MAYA: ActorRef = { id: "p:maya", kind: "person", name: "Maya" };
const JON: ActorRef = { id: "p:jon", kind: "person", name: "Jon" };
const SEYI_ME: ActorRef = { id: "p:seyi", kind: "person", name: "Seyi" };
const CHATGPT: ActorRef = { id: "a:sams-chatgpt", kind: "agent", name: "Sam's ChatGPT" };
const CLAUDE: ActorRef = { id: "a:seyis-claude", kind: "agent", name: "Seyi's Claude" };
const CODEX: ActorRef = { id: "a:codex", kind: "agent", name: "Codex" };
const SORTER: ActorRef = { id: "a:inbox-sorter", kind: "agent", name: "Inbox sorter" };
const ACTORS = [MAYA, JON, CHATGPT, CLAUDE, CODEX, SORTER];

export function liveMapFixture(now: number): MapFixtureSource {
  const graphs = [
    graphFor(SEYI, { "0-inbox": 10, "1-projects": 35, "2-areas": 19, "3-resources": 23, "4-archive": 16 }, 7, true),
    graphFor(PW, { "0-inbox": 6, "1-projects": 18, "2-areas": 12, "3-resources": 14, "4-archive": 9 }, 11, false),
    graphFor(LK, { "0-inbox": 4, "1-projects": 9, "2-areas": 7, "3-resources": 8, "4-archive": 5 }, 13, false),
  ];
  const seyiPaths = graphs[0]!.nodes.map((n) => n.path);
  const find = (title: string) => seyiPaths.find((p) => p.endsWith(`/${slugOf(title)}.md`)) ?? path("1-projects", title);

  const claudeReads = ["Launch plan", "Q4 goals", "Customer interviews", "Weekly update"].map(find);
  const actors: MapActor[] = [
    { ...MAYA, workspaceId: SEYI.id, path: find("Pricing"), doing: "read", at: now - 20_000 },
    { ...JON, workspaceId: SEYI.id, path: find("Support rota"), doing: "edit", at: now - 15_000 },
    { ...CHATGPT, workspaceId: SEYI.id, path: find("Brand"), doing: "edit", at: now - 10_000 },
    { ...CLAUDE, workspaceId: SEYI.id, path: find("Weekly update"), doing: "read", at: now - 5_000, reads: claudeReads },
    { ...CODEX, workspaceId: SEYI.id, path: find("API changes"), doing: "create", at: now - 25_000 },
    { ...SORTER, workspaceId: SEYI.id, path: path("2-areas", "Receipt from Figma"), doing: "move", at: now - 40_000 },
    { ...SEYI_ME, self: true, workspaceId: SEYI.id, path: null, doing: "idle", at: now },
  ];
  const liveEvents: MapEvent[] = [
    { kind: "read", at: now - 150_000, workspaceId: SEYI.id, path: find("Style guide"), actor: CHATGPT },
    { kind: "read", at: now - 110_000, workspaceId: SEYI.id, path: find("Customer interviews"), actor: CLAUDE },
    { kind: "move", at: now - 40_000, workspaceId: SEYI.id, from: find("Receipt from Figma"), to: path("2-areas", "Receipt from Figma"), actor: SORTER },
    { kind: "create", at: now - 25_000, workspaceId: SEYI.id, path: find("API changes"), actor: CODEX },
    { kind: "read", at: now - 20_000, workspaceId: SEYI.id, path: find("Pricing"), actor: MAYA },
    { kind: "edit", at: now - 15_000, workspaceId: SEYI.id, path: find("Support rota"), actor: JON },
    { kind: "edit", at: now - 10_000, workspaceId: SEYI.id, path: find("Brand"), actor: CHATGPT },
    { kind: "read", at: now - 5_000, workspaceId: SEYI.id, path: find("Weekly update"), actor: CLAUDE },
    // Something sent across: a note moved from @seyi to Public Worship today.
    { kind: "move", at: now - 3 * 3_600_000, workspaceId: SEYI.id, from: find("Call with Dana"), to: "1-projects/call-with-dana.md", toWorkspaceId: PW.id, actor: SEYI_ME },
    { kind: "move", at: now - 2 * 3_600_000, workspaceId: PW.id, from: graphs[1]!.nodes[3]!.path, to: `2-areas/${baseName(graphs[1]!.nodes[3]!.path)}`, toWorkspaceId: SEYI.id, actor: CLAUDE },
  ];

  const history = (from: number, to: number): MapEvent[] => {
    const rand = seeded(Math.floor(from / 60_000));
    // The working day: nothing before eight in the morning.
    const morning = new Date(from);
    morning.setHours(8, 0, 0, 0);
    from = Math.max(from, morning.getTime());
    const end = Math.min(to, now);
    const out: MapEvent[] = [];
    const kinds = ["read", "read", "read", "edit", "edit", "create", "move"] as const;
    const span = end - from;
    // Busier mid-morning and mid-afternoon, quiet at lunch.
    const busy = (f: number) => 0.35 + Math.sin(f * Math.PI * 2.2) ** 2;
    for (let i = 0; i < 260; i++) {
      const f = rand();
      if (rand() > busy(f)) continue;
      const at = from + f * span;
      const ws = rand() < 0.75 ? graphs[0]! : graphs[1 + Math.floor(rand() * 2)]!;
      const node = ws.nodes[Math.floor(rand() * ws.nodes.length)]!;
      const actor = ACTORS[Math.floor(rand() * ACTORS.length)]!;
      const kind = kinds[Math.floor(rand() * kinds.length)]!;
      if (kind === "move") {
        const folder = FOLDERS[1 + Math.floor(rand() * 4)]!;
        out.push({ kind: "move", at, workspaceId: ws.workspaceId, from: node.path, to: `${folder}/${baseName(node.path)}`, actor });
      } else {
        out.push({ kind, at, workspaceId: ws.workspaceId, path: node.path, actor });
      }
    }
    // The moments the stills mark.
    out.push(
      { kind: "move", at: from + span * 0.2, workspaceId: SEYI.id, from: find("Receipt from Figma"), to: path("2-areas", "Receipt from Figma"), actor: SORTER },
      { kind: "create", at: from + span * 0.38, workspaceId: SEYI.id, path: find("API changes"), actor: CODEX },
      { kind: "create", at: from + span * 0.55, workspaceId: SEYI.id, path: find("Launch plan"), actor: CLAUDE },
      ...liveEvents.filter((e) => e.at >= from && e.at <= end),
    );
    return out.sort((a, b) => a.at - b.at);
  };

  return { graphs, live: { actors, events: liveEvents }, history };
}
