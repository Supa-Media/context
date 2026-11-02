import {
  READS_AS_GUEST,
  GROUP_SCOPE_PATTERN,
  effectiveVisibility,
  isPlumbing,
  type PrivacyRule,
  sealedCovers,
  type Visibility,
} from "./privacy";

/**
 * Who may be told that the file tree changed at these paths.
 *
 * The console redraws its tree when a context's files change, and the hint that
 * something did is a timestamp a reactive query serves (`treeSignals.ts`). A
 * timestamp is information on its own: served to somebody who cannot see what
 * changed, it tells them *when* a private note was created, moved or deleted —
 * which the tree, the audit and `activity.md` all refuse them. So the stamp is
 * kept per audience and each change moves only the stamps of the audiences
 * that can see one of its paths:
 *
 *  - `"private"` — a caller at private clearance, who sees everything. Every
 *    change that touches a visible path moves it.
 *  - `"team"` — a team caller, for a path whose effective visibility is `team`,
 *    or a folder something beneath which is.
 *  - `"@name"` — a team caller granted that name, for a path pointed at it.
 *
 * A folder counts for every audience that reaches anything beneath it, because
 * `folderVisibleAtScope` makes a folder visible to exactly those readers: a
 * move of `2-areas` is news to the team if `2-areas/shared` is theirs.
 *
 * The caller passes each path as it was before the change and as it is after
 * (a move's source and destination), and the rules as they are now; a path
 * whose visibility the change itself narrowed is reported for its new
 * audience only, and anyone else converges on the periodic reconciliation.
 * That is the safe direction: an under-reported change arrives late, while an
 * over-reported one is a disclosure.
 */
export function treeAudiences(
  paths: readonly string[],
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
): string[] {
  const audiences = new Set<string>();
  const reach = (visibility: Visibility) => {
    if (visibility === "team" || GROUP_SCOPE_PATTERN.test(visibility)) audiences.add(visibility);
  };
  for (const raw of paths) {
    const path = raw.replace(/\/+$/, "");
    if (path === "" || isPlumbing(path)) continue;
    // A sealed path has no audience a role is in, an owner's included; its people converge on the walk (`sealedChats.ts`).
    if (sealedCovers(path, rules)) continue;
    audiences.add("private");
    reach(effectiveVisibility(path, rules, overrides));
    const under = `${path}/`;
    for (const rule of rules) if (rule.prefix.startsWith(under)) reach(rule.vis);
    for (const [key, visibility] of overrides) if (key.startsWith(under)) reach(visibility);
  }
  return [...audiences].sort();
}

/** The audiences a caller reads, from their clearance. See `treeAudiences`. */
export function audiencesOf(scope: "private" | "team", grantedNames: readonly string[]): string[] {
  if (scope === "private") return ["private"];
  const names = grantedNames.map((name) => `@${name}`);
  // A guest is not told about `team` paths (`READS_AS_GUEST`); a row's token is never an audience, so a change to
  // a note open to every account reaches them at the next periodic walk instead. Late, never a disclosure.
  return names.includes(READS_AS_GUEST) ? names : ["team", ...names];
}

/** What `markTreeChanged` accepts as one audience. */
export function isAudience(value: string): boolean {
  return value === "private" || value === "team" || GROUP_SCOPE_PATTERN.test(value);
}
