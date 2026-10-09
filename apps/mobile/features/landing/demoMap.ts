import type { MapEvent, WorkspaceGraph } from "../console/map/live/types";

/**
 * The landing pages' map: four made-up workspaces and thirty seconds of made-up
 * work in them, drawn by the console's own map engine (`console/map/live`).
 *
 * Nothing here is anybody's data. The names, notes and steps are a demo, and
 * the pages say so ("demo") wherever they count anything. What the engine does
 * with them is the real thing: faces for people, robots for AIs, teal while a
 * note is written, a new dot when one is made.
 *
 * A replay rather than live: the engine plays the window and stops at its end,
 * and the page sets the playhead back to the start (`LandingMap`), so the
 * same thirty seconds loop for as long as the page is open.
 */

/** How long the demo's window is, in milliseconds. It plays at 1x. */
export const DEMO_LOOP_MS = 30_000;
/** Where the window starts. Fixed, so a frame is the same on every visit. */
export const DEMO_FROM = Date.UTC(2026, 9, 9, 9, 0, 0);

export const DEMO_IDS = {
  personal: "demo-personal",
  work: "demo-northwind",
  club: "demo-book-club",
  garden: "demo-garden",
} as const;

type Folder = "0-inbox" | "1-projects" | "2-areas" | "3-resources" | "4-archive";
type Act = "read" | "edit" | "create" | "wait";
type Step = readonly [Act, string | null, number];
type DemoActor = { id: string; kind: "person" | "agent"; name: string; start: number; steps: readonly Step[] };
type DemoWorkspace = {
  id: string;
  slug: string;
  name: string;
  kind: "personal" | "shared";
  folders: Record<Folder, readonly string[]>;
  links: readonly (readonly [string, string])[];
  actors: readonly DemoActor[];
};

const WORKSPACES: readonly DemoWorkspace[] = [
  {
    id: DEMO_IDS.personal,
    slug: "maya",
    name: "Personal",
    kind: "personal",
    folders: {
      "0-inbox": ["Voice memo", "Groceries", "Idea for the shed", "Flight receipt", "Call mum"],
      "1-projects": ["Lisbon trip", "Garden beds", "Kitchen shelf", "Half marathon", "Photo album", "Tax return"],
      "2-areas": ["Health", "Money", "Home", "Car", "Friends"],
      "3-resources": ["Recipes", "Book list", "Podcasts", "Wine notes", "Running routes"],
      "4-archive": ["Old budget", "Moving checklist", "2025 goals"],
    },
    links: [["Lisbon trip", "Money"], ["Garden beds", "Recipes"], ["Lisbon trip", "Book list"], ["Health", "Groceries"], ["Half marathon", "Running routes"]],
    actors: [
      { id: "u:maya", kind: "person", name: "Maya", start: 0.4, steps: [["edit", "Lisbon trip", 6], ["read", "Money", 2.5], ["edit", "Garden beds", 6], ["read", "Recipes", 2.5]] },
      { id: "a:maya-context", kind: "agent", name: "Context", start: 1.5, steps: [["edit", "Groceries", 4], ["wait", null, 1], ["create", "Dentist, Tuesday 3pm", 5], ["wait", null, 2]] },
      { id: "a:maya-claude", kind: "agent", name: "Maya's Claude", start: 0.8, steps: [["read", "Lisbon trip", 1.6], ["read", "Money", 1.6], ["read", "Book list", 1.6], ["create", "Packing list", 6], ["wait", null, 2]] },
    ],
  },
  {
    id: DEMO_IDS.work,
    slug: "northwind",
    name: "Northwind",
    kind: "shared",
    folders: {
      "0-inbox": ["Call with Dana", "Receipt from Figma", "Partner intro", "Bug report", "Event invite", "Press request"],
      "1-projects": ["Launch plan", "Pricing", "Customer interviews", "Website refresh", "Hiring", "Q4 goals", "Onboarding emails", "Mobile app", "Partner program", "Annual report"],
      "2-areas": ["Support rota", "Brand", "Finance", "Security", "Team rituals", "Legal"],
      "3-resources": ["Weekly update", "Style guide", "Glossary", "Competitors", "Interview guide", "Templates", "Board deck"],
      "4-archive": ["Summer launch", "Old pricing", "2025 plan", "Offsite"],
    },
    links: [
      ["Launch plan", "Pricing"], ["Launch plan", "Customer interviews"], ["Launch plan", "Website refresh"], ["Launch plan", "Q4 goals"],
      ["Pricing", "Finance"], ["Website refresh", "Brand"], ["Weekly update", "Launch plan"], ["Style guide", "Brand"],
      ["Hiring", "Support rota"], ["Call with Dana", "Customer interviews"], ["Pricing", "Old pricing"], ["Interview guide", "Customer interviews"],
    ],
    actors: [
      { id: "u:jon", kind: "person", name: "Jon", start: 0.2, steps: [["edit", "Launch plan", 6], ["read", "Pricing", 3], ["edit", "Pricing", 6], ["read", "Q4 goals", 3]] },
      { id: "u:priya", kind: "person", name: "Priya", start: 1, steps: [["read", "Weekly update", 3.5], ["edit", "Support rota", 6], ["read", "Hiring", 3], ["edit", "Hiring", 6]] },
      { id: "a:jon-claude", kind: "agent", name: "Jon's Claude", start: 0.6, steps: [["read", "Pricing", 1.4], ["read", "Launch plan", 1.4], ["read", "Customer interviews", 1.4], ["read", "Q4 goals", 1.4], ["create", "Launch recap", 6], ["wait", null, 2.5]] },
      { id: "a:priya-codex", kind: "agent", name: "Priya's Codex", start: 1.4, steps: [["read", "Style guide", 2.2], ["read", "Glossary", 2.2], ["create", "API notes", 6], ["edit", "Website refresh", 6]] },
      { id: "a:sam-chatgpt", kind: "agent", name: "Sam's ChatGPT", start: 2, steps: [["read", "Brand", 3], ["edit", "Brand", 7], ["read", "Finance", 3], ["wait", null, 3]] },
    ],
  },
  {
    id: DEMO_IDS.club,
    slug: "book-club",
    name: "Book club",
    kind: "shared",
    folders: {
      "0-inbox": ["Suggestions"],
      "1-projects": ["October pick", "Author visit"],
      "2-areas": ["Host rota", "Snacks"],
      "3-resources": ["Picks 2026", "Reading guides", "Library hours"],
      "4-archive": ["September", "August", "July"],
    },
    links: [["October pick", "Picks 2026"], ["Author visit", "October pick"]],
    actors: [{ id: "u:ana", kind: "person", name: "Ana", start: 0.8, steps: [["edit", "October pick", 7], ["read", "Host rota", 3]] }],
  },
  {
    id: DEMO_IDS.garden,
    slug: "garden-co-op",
    name: "Garden co-op",
    kind: "shared",
    folders: {
      "0-inbox": ["Compost delivery", "New member"],
      "1-projects": ["Spring beds", "Tool shed", "Open day"],
      "2-areas": ["Watering rota", "Money box"],
      "3-resources": ["Seed list", "Planting calendar", "Suppliers"],
      "4-archive": ["Autumn clean-up"],
    },
    links: [["Spring beds", "Seed list"], ["Spring beds", "Planting calendar"], ["Open day", "New member"]],
    actors: [
      { id: "u:leo", kind: "person", name: "Leo", start: 0.5, steps: [["read", "Seed list", 3], ["edit", "Spring beds", 7]] },
      { id: "a:leo-chatgpt", kind: "agent", name: "Leo's ChatGPT", start: 1.2, steps: [["read", "Watering rota", 2.5], ["edit", "Watering rota", 6], ["wait", null, 2]] },
    ],
  },
];

const slug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** The demo note path a title is filed at: the folder it is listed in, or Projects for one an actor creates. */
function pathOf(ws: DemoWorkspace, title: string): string {
  for (const [folder, titles] of Object.entries(ws.folders)) {
    if (titles.includes(title)) return `${folder}/${slug(title)}.md`;
  }
  return `1-projects/${slug(title)}.md`;
}

/** Every demo workspace's notes and links. A note an actor creates is not here yet: its event adds it. */
export function demoGraphs(): WorkspaceGraph[] {
  return WORKSPACES.map((ws) => {
    const nodes: { path: string; title: string }[] = [];
    const index = new Map<string, number>();
    const edges: [number, number][] = [];
    for (const [folder, titles] of Object.entries(ws.folders)) {
      titles.forEach((title, i) => {
        index.set(title, nodes.length);
        nodes.push({ path: `${folder}/${slug(title)}.md`, title });
        // A folder hangs off its first few notes, the way real folders do.
        if (i > 0) edges.push([nodes.length - 1, index.get(titles[Math.floor((i - 1) / 2)]!)!]);
      });
    }
    for (const [a, b] of ws.links) {
      const from = index.get(a);
      const to = index.get(b);
      if (from !== undefined && to !== undefined && from !== to) edges.push([from, to]);
    }
    // The graph's contract: no duplicate links, either way round.
    const seen = new Set<string>();
    const unique = edges.filter(([a, b]) => {
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { workspaceId: ws.id, slug: ws.slug, name: ws.name, kind: ws.kind, nodes, edges: unique };
  });
}

/** Thirty seconds of the demo actors' steps, each actor repeating theirs until the window ends. */
export function demoEvents(from = DEMO_FROM, loopMs = DEMO_LOOP_MS): MapEvent[] {
  const events: MapEvent[] = [];
  for (const ws of WORKSPACES) {
    for (const actor of ws.actors) {
      const ref = { id: actor.id, kind: actor.kind, name: actor.name };
      const created = new Set<string>();
      let t = actor.start * 1000;
      for (let i = 0; t < loopMs; i = (i + 1) % actor.steps.length) {
        const [act, title, seconds] = actor.steps[i]!;
        if (act !== "wait" && title !== null) {
          // A note is created once; going round again, it is written to.
          const kind = act === "create" && created.has(title) ? "edit" : act;
          if (act === "create") created.add(title);
          events.push({ kind, at: from + t, workspaceId: ws.id, path: pathOf(ws, title), actor: ref });
        }
        t += seconds * 1000;
      }
    }
  }
  return events.sort((a, b) => a.at - b.at);
}

/** How many people and AIs the demo has, for a "5 people and 6 AIs" line. */
export function demoCounts(): { people: number; agents: number } {
  const actors = WORKSPACES.flatMap((ws) => ws.actors);
  return { people: actors.filter((a) => a.kind === "person").length, agents: actors.filter((a) => a.kind === "agent").length };
}

/** A camera stop: everything, one workspace, or one of its folders, from `at` seconds into the loop. */
export type TourStop = { at: number; workspaceId: string | null; folder: string };

/** The camera's thirty seconds: all workspaces, into work and its projects, out, into Personal, out. */
export const DEMO_TOUR: readonly TourStop[] = [
  { at: 0, workspaceId: null, folder: "" },
  { at: 4.5, workspaceId: DEMO_IDS.work, folder: "" },
  { at: 9, workspaceId: DEMO_IDS.work, folder: "1-projects" },
  { at: 15.5, workspaceId: null, folder: "" },
  { at: 19, workspaceId: DEMO_IDS.personal, folder: "" },
  { at: 26.5, workspaceId: null, folder: "" },
];

/** The stop the camera should be at `seconds` into the loop. */
export function tourStopAt(seconds: number, tour: readonly TourStop[] = DEMO_TOUR): TourStop {
  let current = tour[0]!;
  for (const stop of tour) if (stop.at <= seconds) current = stop;
  return current;
}
