/**
 * The Projects folder as the Areas page needs it: which projects serve which
 * area, and the one write that attaches a project to an area or detaches it.
 *
 * The notes are the Projects page's own read (`useFolderNotes`), through the
 * same page cache, so a workspace that has had its Projects folder open, or
 * preloaded, draws the counts at once and nothing reads a note's text: an
 * `area:` line is front matter. The read is at the viewer's clearance, so a
 * project they cannot see is never counted. A write goes through that read's
 * own `chooseMany`, so it is drawn at once and taken back if refused.
 */

import { useCallback, useMemo } from "react";
import { useFolderNotes, type FolderPageHost } from "../useFolderPage";
import { attachChange, attachChoices, groupedProjects, projectsUnder, type AreaProject, type AreaProjects } from "./areaProjects";

export interface AreaProjectsTools {
  /** The projects that serve an area or its sub-areas. */
  readonly of: (area: string) => AreaProjects;
  /** What "Attach a project" offers an area. */
  readonly choices: (area: string) => readonly AreaProject[];
  /** Attaches a project to an area, or detaches it with `null`; a problem sentence, or null when saved. Absent for a reader. */
  readonly attach?: (project: AreaProject, area: string | null) => Promise<string | null>;
}

export function useAreaProjects(host: FolderPageHost | undefined, root: string): AreaProjectsTools | null {
  // Never the workspace's root: with no Projects folder there is nothing to read.
  const read = useFolderNotes(root === "" ? undefined : host, root);
  const projects = useMemo(() => (read.notes === null ? [] : projectsUnder(root, read.notes)), [read.notes, root]);
  const byArea = useMemo(() => new Map<string, AreaProjects>(), [projects]);
  const of = useCallback(
    (area: string) => {
      const kept = byArea.get(area);
      if (kept !== undefined) return kept;
      const grouped = groupedProjects(area, projects);
      byArea.set(area, grouped);
      return grouped;
    },
    [byArea, projects],
  );
  const choices = useCallback((area: string) => attachChoices(area, projects), [projects]);
  const { chooseMany, canEdit } = read;
  const attach = useCallback(
    (project: AreaProject, area: string | null) => {
      const { target, changes, creates } = attachChange(project, area);
      return chooseMany(target, changes, creates);
    },
    [chooseMany],
  );
  return useMemo(() => {
    if (host === undefined || root === "") return null;
    return { of, choices, ...(canEdit ? { attach } : {}) };
  }, [host, root, of, choices, canEdit, attach]);
}
