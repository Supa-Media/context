/**
 * Page a's story, as a schedule (Dev, 2026-10-11, over eighteen rounds of a
 * preview): a cluttered life, about sixty notes, tangled. Two AI helpers sort
 * it into a Personal workspace laid out as Inbox, Projects, Areas, Resources
 * and Archive; new messages keep landing in the Inbox and get sorted out of
 * it. A side project grows inside Personal from "New app" into a friend
 * hangout app. When co-founders join, it moves into its own shared workspace,
 * Hangg, their own assistants start working, and they bring notes of their
 * own. Then the day starts again.
 *
 * Pure and seeded: the same story every visit, so it can be tested. Times are
 * in ms from the start of the loop. `chaosDraw.ts` draws it.
 */

export const ROLES = ["inbox", "projects", "areas", "resources", "archive"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_NAME: Record<Role, string> = {
  inbox: "Inbox",
  projects: "Projects",
  areas: "Areas",
  resources: "Resources",
  archive: "Archive",
};
export const WORKSPACES = ["Personal workspace", "Hangg · shared workspace"] as const;
/** The shared workspace the side project moves into. */
export const HG = 1;
/** Claude and ChatGPT sort Personal; the last two arrive with the co-founders. */
export const HELPERS = ["Claude", "ChatGPT", "Maya's Codex", "Jon's Claude"] as const;
const own = (founder: number) => 2 + founder;

/** How long a note takes to move, a named note is read before it moves, a note flies in, a co-founder walks in, the loop fades. */
export const MOVE = 750;
export const SHOW = 700;
export const FLY = 700;
export const ENTER = 1200;
export const FADE = 900;
const SHIFT_STEP = 200;

export type Icon = "email" | "text" | "calendar" | "meeting" | "chat" | "doc";
export type Folder = { ws: number; role: Role; n: number };
export type Stop = { t: number; folder: number; k?: number; helper?: number };
export type Note = {
  dest: number;
  stops: Stop[];
  stay?: boolean;
  mover?: boolean;
  /** For a mover, the folder in Hangg it ends up in. */
  to?: number;
  /** Which co-founder brought it. */
  founder?: number;
  /** Where it lies loose, and where it flies in from, as fractions of the canvas. */
  lx: number;
  ly: number;
  ex: number;
  ey: number;
  /** Where a co-founder's note lies, relative to them. */
  near?: [number, number];
  arrive: number;
  ready: number;
  icon: Icon;
  /** Whether a helper names it on one of its moves. */
  named?: boolean;
};
/** A move a helper names while it reads and carries the note: a card with what it is and its title. */
export type Job = { n: Note; stop: number; t: number; helper: number; kind: string; label: string };
export type Founder = { name: string; from: [number, number]; dy: number; at: number };

export type Story = {
  folders: Folder[];
  nodes: Note[];
  movers: Note[];
  late: Note[];
  founders: Founder[];
  jobs: Job[];
  tangle: [Note, Note][];
  links: [Note, Note][];
  /** When Hangg is made, when the app's notes start moving over, and when the loop ends. */
  form: number;
  shift: number;
  shiftEnd: number;
  hold: number;
};

export const folderIndex = (ws: number, role: Role) => ws * ROLES.length + ROLES.indexOf(role);
export const lastStop = (n: Note) => n.stops[n.stops.length - 1]!;

const seeded = (start: number) => {
  let s = start;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
};

/** What each note is when it lands: an email, a text, a calendar invite, a meeting, a chat with a chatbot, a doc. */
const MIX: Record<Role, Icon[]> = {
  projects: ["chat", "email", "meeting", "doc", "chat"],
  areas: ["text", "calendar", "email", "text"],
  resources: ["doc", "doc", "chat"],
  archive: ["email", "doc", "email"],
  inbox: ["email", "text", "calendar"],
};
const ICON_OF: Record<string, Icon> = { Email: "email", Chat: "chat", Meeting: "meeting", Text: "text", Invite: "calendar" };

export function buildStory(): Story {
  const rnd = seeded(11);
  const irnd = seeded(29);
  const pickOf = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)]!;
  const F = folderIndex;
  const folders: Folder[] = [];
  WORKSPACES.forEach((_, ws) => ROLES.forEach((role) => folders.push({ ws, role, n: 0 })));
  const founders: Founder[] = [
    { name: "Maya", from: [1.08, 0.5], dy: -16, at: 0 },
    { name: "Jon", from: [0.8, 1.12], dy: 16, at: 0 },
  ];

  const nodes: Note[] = [];
  const make = (dest: number, extra: Partial<Note> = {}): Note => {
    const n: Note = { dest, stops: [], lx: 0, ly: 0, ex: 0, ey: 0, arrive: 0, ready: 0, icon: "doc", ...extra };
    nodes.push(n);
    return n;
  };
  const add = (dest: number, count: number, extra?: Partial<Note>) => {
    for (let i = 0; i < count; i++) make(dest, extra);
  };
  add(F(0, "projects"), 4);
  add(F(0, "areas"), 14);
  add(F(0, "resources"), 10);
  add(F(0, "archive"), 6);
  add(F(0, "inbox"), 1, { stay: true });
  // The app starts life as a project in Personal; when co-founders join, it moves into its own workspace.
  const movers: Note[] = [];
  for (let i = 0; i < 12; i++) {
    movers.push(make(F(0, "projects"), { mover: true, to: F(HG, i < 6 ? "projects" : i < 9 ? "areas" : "resources") }));
  }
  const late: Note[] = [];
  for (let i = 0; i < 8; i++) {
    const role: Role = i < 3 ? "projects" : i < 5 ? "areas" : i < 6 ? "resources" : i < 7 ? "archive" : "inbox";
    late.push(make(F(HG, role), { founder: i % 2, stay: i >= 7 }));
  }
  nodes.forEach((n) => {
    n.lx = 0.04 + rnd() * 0.92;
    n.ly = 0.05 + rnd() * 0.9;
  });
  nodes.forEach((n) => {
    const mix = MIX[folders[n.dest]!.role];
    n.icon = mix[Math.floor(irnd() * mix.length)]!;
    const a = irnd() * Math.PI * 2; // they fly in from off the edge
    n.ex = 0.5 + Math.cos(a) * 0.75;
    n.ey = 0.5 + Math.sin(a) * 0.75;
  });
  late.forEach((n) => {
    const a = rnd() * 6.28;
    const d = 0.05 + rnd() * 0.06;
    n.near = [Math.cos(a) * d, Math.sin(a) * d * 1.4];
  });

  // The day starts already cluttered: most notes are here before anything moves, and get sorted straight into place.
  // New ones keep landing in the Inbox, and get sorted out of it a little later.
  const early = nodes
    .filter((n) => n.founder === undefined)
    .map((n): [number, Note] => [rnd(), n])
    .sort((a, b) => a[0] - b[0])
    .map((x) => x[1]);
  const fresh = new Set(
    early
      .filter((n) => !n.mover && !n.stay)
      .slice(0, 11)
      .concat(early.filter((n) => n.stay)),
  );
  early
    .filter((n) => !fresh.has(n))
    .forEach((n) => {
      n.arrive = -FLY;
      n.ready = 1400 + rnd() * 600;
    });
  let clock = 1000;
  [...fresh]
    .sort(() => rnd() - 0.5)
    .forEach((n) => {
      n.arrive = clock;
      clock += rnd() < 0.2 ? 500 + rnd() * 700 : 120 + rnd() * 260;
      n.ready = n.arrive + FLY + 200 + rnd() * 500;
    });
  const inboxK = [0, 0];
  const viaInbox = (n: Note, ws: number, at: number) => {
    n.stops.push({ t: at, folder: F(ws, "inbox"), k: inboxK[ws]!++ % 5 });
    if (!n.stay) n.stops.push({ t: at + MOVE + 900 + rnd() * 2200, folder: n.dest });
  };
  let lastFile = 0;
  early
    .slice()
    .sort((a, b) => a.ready - b.ready)
    .forEach((n) => {
      lastFile = Math.max(n.ready, lastFile + 62);
      if (fresh.has(n)) viaInbox(n, folders[n.dest]!.ws, lastFile);
      else n.stops.push({ t: lastFile, folder: n.dest });
    });
  const lastOf = (list: Note[]) => Math.max(...list.map((n) => lastStop(n).t));
  // When the first co-founder joins, the app gets its own workspace and its notes move over from Personal.
  founders[0]!.at = lastOf(early) + MOVE + 400;
  const form = founders[0]!.at + ENTER * 0.6;
  const shift = form + 900;
  movers.forEach((n, i) => n.stops.push({ t: shift + i * SHIFT_STEP, folder: n.to! }));
  // The co-founders bring notes of their own, which keep landing in Hangg's Inbox.
  founders[1]!.at = shift + movers.length * SHIFT_STEP + 300;
  late.sort((a, b) => a.founder! - b.founder!);
  clock = founders[0]!.at + ENTER * 0.6;
  late.forEach((n) => {
    const from = founders[1]!.at + ENTER * 0.6;
    if (n.founder === 1 && clock < from) clock = from;
    n.arrive = clock;
    clock += rnd() < 0.15 ? 300 + rnd() * 400 : 60 + rnd() * 120;
    viaInbox(n, HG, n.arrive + FLY + 200 + rnd() * 500);
  });
  late.sort((a, b) => lastStop(a).t - lastStop(b).t);
  const hold = lastOf(nodes) + MOVE + 3500;

  // Sunflower slots per folder, in the order notes end up there; movers take the outside, so what stays is compact.
  const slots = folders.map(() => 0);
  nodes
    .flatMap((n) => n.stops.map((st): [Note, Stop] => [n, st]))
    .filter(([n, st]) => st.k === undefined && !(n.mover && st.folder === n.dest))
    .sort((a, b) => a[1].t - b[1].t)
    .forEach(([, st]) => {
      st.k = slots[st.folder]!++;
    });
  movers.forEach((n) => {
    n.stops[0]!.k = slots[n.dest]!++;
  });
  folders.forEach((f, i) => {
    f.n = f.role === "inbox" ? 5 : nodes.filter((n) => n.stops.some((st) => st.folder === i)).length;
  });

  // The ones that get named, while a helper reads and carries them, spaced so each helper has one at a time.
  const named: { n: Note; stop: number; kind: string; label: string }[] = [];
  const taken: number[] = [];
  const free = (t: number, gap: number) => taken.every((x) => Math.abs(x - t) >= gap);
  const nameAt = (n: Note, stop: number, kind: string, label: string) => {
    // A note named twice (the app's first idea is also where Hangg gets its name) keeps the icon it landed as.
    if (!n.named) n.icon = ICON_OF[kind] ?? "doc";
    n.named = true;
    named.push({ n, stop, kind, label });
    taken.push(n.stops[stop]!.t);
  };
  // The app's story first: an idea, then a friend hangout app, then Hangg once it has its own workspace.
  const byFirst = movers.slice().sort((a, b) => a.stops[0]!.t - b.stops[0]!.t);
  nameAt(byFirst[0]!, 0, "Idea", "New app idea");
  nameAt(byFirst.slice(6).find((n) => free(n.stops[0]!.t, 1100)) ?? byFirst[8]!, 0, "Chat", "Friend hangout app?");
  nameAt(movers[0]!, 1, "Meeting", "Let's call it Hangg");
  nameAt(movers[5]!, 1, "Doc", "Hangg pitch deck");
  const pick = (pool: Note[], [folder, kind, label]: [number | undefined, string, string], gap = 1100) => {
    const n = pool.find(
      (m) =>
        (folder === undefined || lastStop(m).folder === folder) &&
        !m.mover &&
        !m.stay &&
        !m.named &&
        free(lastStop(m).t, gap),
    );
    if (n) nameAt(n, n.stops.length - 1, kind, label);
  };
  const byLast = early.slice().sort((a, b) => lastStop(a).t - lastStop(b).t);
  const personal: [number, string, string][] = [
    [F(0, "areas"), "Text", "Mom: call me back"],
    [F(0, "resources"), "Book", "Atomic Habits"],
    [F(0, "archive"), "Email", "2019 tax receipts"],
    [F(0, "areas"), "Invite", "Dentist, Thursday 9am"],
    [F(0, "projects"), "Note", "Half marathon plan"],
    [F(0, "resources"), "Article", "Pricing your work"],
  ];
  personal.forEach((l) => pick(byLast, l));
  // The co-founders' notes are named only once both "joined" cards are gone.
  const lateFrom = founders[1]!.at + ENTER + 800 + SHOW;
  taken.push(lateFrom - 700);
  const shared: [undefined, string, string][] = [
    [undefined, "Email", "Beta tester signups"],
    [undefined, "Invite", "Launch party, Friday"],
    [undefined, "Code", "Website, built with Claude"],
  ];
  shared.forEach((l) =>
    pick(
      late.filter((n) => lastStop(n).t >= lateFrom),
      l,
      SHOW + MOVE, // one assistant carries these, so each card has its turn
    ),
  );

  // Named notes alternate between Claude and ChatGPT; once co-founders join, their own assistants take their notes,
  // and Maya's Codex helps carry the app over to Hangg.
  let alt = 0;
  const jobs: Job[] = named
    .sort((a, b) => a.n.stops[a.stop]!.t - b.n.stops[b.stop]!.t)
    .map(({ n, stop, kind, label }) => {
      const helper = n.founder !== undefined ? own(n.founder) : n.mover && stop === 1 && n === movers[0] ? own(0) : alt++ % 2;
      n.stops[stop]!.helper = helper;
      return { n, stop, t: n.stops[stop]!.t, helper, kind, label };
    });
  late.forEach((n) =>
    n.stops.forEach((s) => {
      if (s.helper === undefined) s.helper = own(n.founder!);
    }),
  );
  movers.forEach((n, i) => {
    const s = n.stops[1]!;
    if (s.helper === undefined) s.helper = i % 2 ? own(0) : irnd() < 0.5 ? 0 : 1;
  });
  // Every move is one of the helpers' work, not just the named ones.
  nodes.forEach((n) =>
    n.stops.forEach((s) => {
      if (s.helper === undefined) s.helper = irnd() < 0.5 ? 0 : 1;
    }),
  );

  // The tangle: loose notes tied to each other. Filed notes link to each other, mostly within a folder, never
  // across workspaces. Archive and Inbox keep to themselves.
  const tangle: [Note, Note][] = [];
  const links: [Note, Note][] = [];
  const backlog = early.filter((n) => !fresh.has(n));
  backlog.forEach((n) => {
    const c = 1 + (rnd() < 0.5 ? 1 : 0);
    for (let j = 0; j < c; j++) tangle.push([n, pickOf(backlog)]);
  });
  fresh.forEach((n) => {
    for (let j = 0; j < 2; j++) tangle.push([n, pickOf(early)]);
  });
  const final = (n: Note) => lastStop(n).folder;
  const linkable = (n: Note) => !["archive", "inbox"].includes(folders[final(n)]!.role);
  nodes.filter(linkable).forEach((n) => {
    const mates = nodes.filter((m) => final(m) === final(n) && m !== n);
    if (rnd() < 0.45 && mates.length) links.push([n, pickOf(mates)]);
    if (rnd() < 0.08) {
      const o = pickOf(nodes);
      if (linkable(o) && folders[final(o)]!.ws === folders[final(n)]!.ws) links.push([n, o]);
    }
  });

  return { folders, nodes, movers, late, founders, jobs, tangle, links, form, shift, shiftEnd: shift + movers.length * SHIFT_STEP, hold };
}
