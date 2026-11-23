/**
 * The demo areas, from the idea note's demo set and nothing else. Where the
 * note gives no number, the value is `null` and the card draws "—".
 * Sparkline series are invented review shapes, not measurements.
 */

export type Health = "ok" | "warn" | "crit" | "neutral";
export type Mode = "Entrepreneur" | "Manager" | "Technician";
export const MODES: readonly Mode[] = ["Entrepreneur", "Manager", "Technician"];

export type Owner =
  | { kind: "person"; name: string; mainAgent?: "Tex" }
  | { kind: "tex" }
  | null;

export interface Metric {
  name: string;
  value: string | null;
  target?: string;
  source: string | null;
  health: Health;
  series?: number[];
}

export interface Area {
  id: string;
  name: string;
  folder: string;
  purpose: string | null;
  owner: Owner;
  /** An agent working in the area beside its owner. */
  helper?: { name: string; role: Mode };
  modes: Mode[];
  metrics: Metric[];
  rights: string[];
  gap?: string;
  children: string[];
  projects: string[];
}

export const AREAS: Record<string, Area> = {
  company: {
    id: "company",
    name: "Company",
    folder: "areas",
    purpose: null,
    owner: { kind: "person", name: "Seyi", mainAgent: "Tex" },
    modes: ["Entrepreneur"],
    metrics: [
      { name: "Monthly revenue", value: null, source: "written weekly by agent", health: "neutral" },
      { name: "Monthly burn", value: null, source: "written weekly by agent", health: "neutral" },
      { name: "Burn per user", value: null, source: "written weekly by agent", health: "neutral" },
      { name: "Active users", value: null, source: "written weekly by agent", health: "neutral" },
      { name: "Growth", value: null, source: null, health: "neutral" },
    ],
    rights: [],
    children: ["finance", "engineering", "product", "design", "tex"],
    projects: [],
  },
  finance: {
    id: "finance",
    name: "Finance",
    folder: "areas/finance",
    purpose: null,
    owner: { kind: "person", name: "Seyi", mainAgent: "Tex" },
    modes: ["Entrepreneur", "Manager"],
    metrics: [
      {
        name: "Monthly cost",
        value: "$512",
        target: "$600",
        source: "written weekly by agent",
        health: "ok",
        series: [560, 590, 575, 540, 530, 512],
      },
    ],
    rights: ["Spending over $20 needs Seyi's approval."],
    children: ["subscriptions", "payroll"],
    projects: [],
  },
  subscriptions: {
    id: "subscriptions",
    name: "Subscriptions",
    folder: "areas/finance/subscriptions",
    purpose: null,
    owner: { kind: "person", name: "Seyi", mainAgent: "Tex" },
    modes: [],
    metrics: [],
    rights: [],
    children: [],
    projects: [],
  },
  payroll: {
    id: "payroll",
    name: "Payroll",
    folder: "areas/finance/payroll",
    purpose: null,
    owner: { kind: "person", name: "Seyi", mainAgent: "Tex" },
    modes: [],
    metrics: [],
    rights: [],
    children: [],
    projects: [],
  },
  engineering: {
    id: "engineering",
    name: "Engineering",
    folder: "areas/engineering",
    purpose: null,
    owner: { kind: "person", name: "Dev2" },
    helper: { name: "Claude Code", role: "Technician" },
    modes: ["Manager", "Technician"],
    metrics: [
      {
        name: "PR time to ship",
        value: "2.4 days",
        source: "from GitHub",
        health: "warn",
        series: [1.6, 1.8, 2.1, 1.9, 2.3, 2.4],
      },
      {
        name: "MCP response p50",
        value: "380ms",
        source: "from the gateway",
        health: "neutral",
        series: [410, 395, 400, 385, 390, 380],
      },
    ],
    rights: [],
    children: [],
    projects: ["tex-quality", "tex-reliability", "search-quality"],
  },
  product: {
    id: "product",
    name: "Product",
    folder: "areas/product",
    purpose: null,
    owner: { kind: "person", name: "Seyi", mainAgent: "Tex" },
    modes: [],
    metrics: [
      { name: "Product quality", value: "7/10", source: "owner score", health: "neutral" },
      { name: "Notes created a week", value: null, source: "written weekly by agent", health: "neutral" },
      { name: "Tokens through a week", value: null, source: "written weekly by agent", health: "neutral" },
    ],
    rights: [],
    children: [],
    projects: [],
  },
  design: {
    id: "design",
    name: "Design",
    folder: "areas/design",
    purpose: null,
    owner: null,
    modes: [],
    metrics: [{ name: "Design quality", value: null, source: "survey of 3", health: "neutral" }],
    rights: [],
    children: [],
    projects: [],
  },
  tex: {
    id: "tex",
    name: "Tex",
    folder: "areas/tex",
    purpose: null,
    owner: { kind: "tex" },
    modes: ["Technician"],
    metrics: [],
    rights: [],
    gap: "No manager loop",
    children: [],
    projects: [],
  },
};

/** The area the open note serves: `projects/tex-quality` is linked to Engineering. */
export const HERE = { area: "engineering", project: "tex-quality" };

export function parentOf(id: string): Area | null {
  return Object.values(AREAS).find((area) => area.children.includes(id)) ?? null;
}

export function trail(id: string): Area[] {
  const out: Area[] = [];
  for (let at = parentOf(id); at !== null; at = parentOf(at.id)) out.unshift(at);
  return out;
}
