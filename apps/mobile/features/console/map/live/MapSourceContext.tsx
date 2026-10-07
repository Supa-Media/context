import { createContext, useContext } from "react";
import type { MapActor } from "./engine";
import type { MapEvent, WorkspaceGraph } from "./types";

/**
 * A map that draws invented data instead of asking the control plane and the
 * gateway: the screenshot fixture (`features/e2e/MapFixture.tsx`) and nothing
 * else. Absent — everywhere in the product — and the page reads the real
 * graphs, polls the real activity and fetches the real history.
 */
export type MapFixtureSource = {
  graphs: WorkspaceGraph[];
  /** Who is in each workspace now, and what has just happened. */
  live: { actors: MapActor[]; events: MapEvent[] };
  /** The changes in a replay's window, oldest first. */
  history: (from: number, to: number) => MapEvent[];
};

const MapSourceContext = createContext<MapFixtureSource | null>(null);

export const MapSourceProvider = MapSourceContext.Provider;

export function useMapFixtureSource(): MapFixtureSource | null {
  return useContext(MapSourceContext);
}
