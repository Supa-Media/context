/**
 * `useLab()`: the Lab's state for React, and its saving through Convex.
 *
 * Views read `lab` (`engine/state.ts`) and call the engine's functions by the
 * artifact's names; this hook only makes them draw again when the state
 * changes. `useLabSync()` runs once in the shell: it loads every staff
 * member's saved versions and case edits (`functions/texLab.ts`) the way the
 * artifact's page database did, and registers how a save reaches them.
 */
import { useEffect, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { buildTraces } from "./engine/traces";
import { allCases } from "./engine/diff";
import { clone, emit, isMain, lab, MAIN, setSaver, snapshot, subscribe, toast } from "./engine/state";
import type { LabCase, LabVersion } from "./types";

/** Draw again whenever the Lab's state changes; returns the state. */
export function useLab() {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return lab;
}

/** A case edit kept for every staff member (or a new case), the artifact's `saveCase`. */
let caseSaver: ((key: string, data: string | null) => Promise<unknown>) | null = null;
export async function saveCase(e: LabCase) {
  lab.caseEdits[e.area + "/" + e.id] = e;
  emit();
  try {
    await caseSaver?.(e.area + "/" + e.id, JSON.stringify(e));
    toast("Case kept for everyone");
  } catch {
    toast("Couldn't save the case");
  }
}
export async function dropCase(k: string) {
  const had = lab.caseEdits[k];
  delete lab.caseEdits[k];
  emit();
  if (had) await caseSaver?.(k, null).catch(() => undefined);
}
/** Run results on main are kept with the main row (the artifact's `saveMainResults`). */
let mainSaver: (() => Promise<unknown>) | null = null;
export const saveMainResults = () => mainSaver?.();

const parse = <T,>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function useLabSync(enabled: boolean) {
  const data = useQuery(api.functions.texLab.list, enabled ? {} : "skip");
  const save = useMutation(api.functions.texLab.saveVersion);
  const saveCaseRow = useMutation(api.functions.texLab.saveCase);

  useEffect(() => {
    const toRow = (v: LabVersion) => ({
      versionId: v.id,
      name: v.name,
      graph: JSON.stringify(v.graph),
      picks: JSON.stringify(v.picks || {}),
      ...(v.areas ? { areas: JSON.stringify(v.areas) } : {}),
      results: JSON.stringify(v.results || []),
      createdAt: v.createdAt || Date.now(),
    });
    setSaver(async (v) => {
      await save(toRow(v));
    });
    caseSaver = (key, d) => saveCaseRow({ key, data: d });
    mainSaver = () => save(toRow({ ...MAIN, graph: { nodes: [], edges: [] } }));
    return () => {
      setSaver(null);
      caseSaver = null;
      mainSaver = null;
    };
  }, [save, saveCaseRow]);

  useEffect(() => {
    if (!data) return;
    lab.myId = data.me;
    lab.names = data.names;
    const list: LabVersion[] = [MAIN];
    for (const x of data.versions) {
      if (x.versionId === "main") {
        MAIN.results = parse(x.results, []);
        continue;
      }
      list.push({ id: x.versionId, name: x.name, authorId: x.authorId, graph: parse(x.graph, { nodes: [], edges: [] }), picks: parse(x.picks, {}), areas: parse<string[] | null>(x.areas, null), results: parse(x.results, []), createdAt: x.createdAt, updatedAt: x.updatedAt });
    }
    lab.versions = list;
    lab.sync = `Shared · ${list.length - 1} saved version${list.length === 2 ? "" : "s"}`;
    if (!lab.dirty) {
      const f = lab.versions.find((v) => v.id === lab.cur.id);
      if (f) lab.cur = clone(f);
    } else if (isMain()) lab.cur.results = MAIN.results;
    const m: Record<string, LabCase> = {};
    for (const c of data.caseEdits) {
      const x = parse<LabCase | null>(c.data, null);
      if (x) m[x.area + "/" + x.id] = x;
    }
    lab.caseEdits = m;
    buildTraces(allCases());
    emit();
  }, [data]);
}
