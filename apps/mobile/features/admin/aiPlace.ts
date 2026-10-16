/**
 * Where somebody is inside the AI tab, as the part of the address after
 * `/admin/ai/` (boards 8-16): a view, then a job, helper or skill, then a
 * part of it.
 *
 *   /admin/ai                                   the overview
 *   /admin/ai/jobs[/<job>[/cases|setups|runs]]  a job's page and its tabs
 *   /admin/ai/jobs/<job>/compare/<setup>        a candidate beside live
 *   /admin/ai/helpers[/<helper>]                helper agents
 *   /admin/ai/skills[/<skill>]                  skills, one opened beside
 *   /admin/ai/activity                          what agents and people did
 *   /admin/ai/files[/<part>]                    the raw ai/ folder
 *
 * Every segment after the view is a name from a note or from code, so it is
 * held to letters, digits, `.`, `_` and `-`: nothing else is a place.
 */

export const AI_VIEWS = ["overview", "jobs", "helpers", "skills", "activity", "files"] as const;
export type AiViewKey = (typeof AI_VIEWS)[number];

export const JOB_TABS = ["overview", "cases", "setups", "runs"] as const;
export type JobTab = (typeof JOB_TABS)[number];

export const FILE_PARTS = ["attention", "jobs", "skills", "tests", "setups", "results", "other"] as const;

export type AiPlace =
  | { view: "overview" }
  | { view: "jobs"; job: string | null; tab: JobTab; compare: string | null }
  | { view: "helpers"; helper: string | null }
  | { view: "skills"; skill: string | null }
  | { view: "activity" }
  | { view: "files"; part: (typeof FILE_PARTS)[number] };

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The place a sub-address names, or null when it names none. */
export function parseAiPlace(sub: string | null): AiPlace | null {
  if (sub === null || sub === "") return { view: "overview" };
  const parts = sub.split("/");
  const [view, a, b, c, ...rest] = parts;
  if (rest.length > 0) return null;
  if (!(AI_VIEWS as readonly string[]).includes(view!)) return null;
  if ([a, b, c].some((part) => part !== undefined && !NAME.test(part))) return null;
  switch (view as AiViewKey) {
    case "overview":
    case "activity":
      return a === undefined ? { view: view as "overview" | "activity" } : null;
    case "jobs":
      if (a === undefined) return { view: "jobs", job: null, tab: "overview", compare: null };
      if (b === undefined) return { view: "jobs", job: a, tab: "overview", compare: null };
      if (b === "compare") return c === undefined ? null : { view: "jobs", job: a, tab: "setups", compare: c };
      if (c !== undefined || !(JOB_TABS as readonly string[]).includes(b)) return null;
      return { view: "jobs", job: a, tab: b as JobTab, compare: null };
    case "helpers":
      return b === undefined ? { view: "helpers", helper: a ?? null } : null;
    case "skills":
      return b === undefined ? { view: "skills", skill: a ?? null } : null;
    case "files":
      if (b !== undefined) return null;
      if (a === undefined) return { view: "files", part: "attention" };
      return (FILE_PARTS as readonly string[]).includes(a) ? { view: "files", part: a as (typeof FILE_PARTS)[number] } : null;
  }
}

/** The sub-address for a place: the inverse of `parseAiPlace`, null for the overview. */
export function aiSub(place: AiPlace): string | null {
  switch (place.view) {
    case "overview":
      return null;
    case "activity":
      return "activity";
    case "jobs":
      if (place.job === null) return "jobs";
      if (place.compare !== null) return `jobs/${place.job}/compare/${place.compare}`;
      return place.tab === "overview" ? `jobs/${place.job}` : `jobs/${place.job}/${place.tab}`;
    case "helpers":
      return place.helper === null ? "helpers" : `helpers/${place.helper}`;
    case "skills":
      return place.skill === null ? "skills" : `skills/${place.skill}`;
    case "files":
      return place.part === "attention" ? "files" : `files/${place.part}`;
  }
}
