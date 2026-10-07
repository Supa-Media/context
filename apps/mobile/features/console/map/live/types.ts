/**
 * The live workspace map's shared shapes.
 *
 * One file both sides agree on: the data hooks fill these from the control
 * plane and the gateway, and the canvas engine (`engine/`) draws only these.
 * Nothing here knows about React, Convex or the network.
 *
 * Paths are always workspace-relative note keys (`1-projects/launch.md`),
 * already filtered to what the viewer may see: the engine never receives a
 * path it should not draw, and an edge only ever joins two visible notes.
 */

/** One note on the map. */
export type MapNode = {
  path: string;
  /** Display name: the file name without `.md`, or its first heading. */
  title: string;
};

/** Every visible note of one workspace and the links between them. */
export type WorkspaceGraph = {
  workspaceId: string;
  slug: string;
  /** What the person calls it ("Personal", "Supa"). */
  name: string;
  kind: "personal" | "shared";
  nodes: MapNode[];
  /** Index pairs into `nodes`, source first. No self-links, no duplicates. */
  edges: [number, number][];
  /** True when the graph was cut at the size limit. */
  truncated?: boolean;
};

/** What someone is doing to a note right now. */
export type Doing = "read" | "edit" | "create" | "move" | "idle";

/** A person or an AI tool working in a workspace right now. */
export type Actor = {
  /** Stable within a workspace (`u:<id>` for people, `a:<id>` for agents). */
  id: string;
  kind: "person" | "agent";
  /** "Maya", or for agents the owner-qualified name: "Seyi's Claude". */
  name: string;
  /** The viewer themselves. */
  self?: boolean;
  /** The note they are on, or null when they are in the workspace but not on a visible note. */
  path: string | null;
  doing: Doing;
  /** Epoch ms of the last signal. */
  at: number;
  /**
   * Agents only: notes this agent read in the live window, oldest first.
   * Drives "What an AI is reading".
   */
  reads?: string[];
};

/**
 * Something that happened, for animation and replay. Live mode turns poll
 * diffs into these; replay builds them from the workspace's activity history.
 */
export type MapEvent =
  | {
      kind: "read" | "edit" | "create";
      at: number;
      workspaceId: string;
      path: string;
      actor: ActorRef;
    }
  | {
      kind: "move";
      at: number;
      workspaceId: string;
      from: string;
      to: string;
      /** Set when the note left for another workspace. */
      toWorkspaceId?: string;
      actor: ActorRef;
    };

export type ActorRef = { id: string; kind: "person" | "agent"; name: string };

/** Which notes and workspaces are on the map. */
export type MapScope = { kind: "one"; workspaceId: string } | { kind: "all" };

/** The map's two layouts of the same data. */
export type MapView = "map" | "folders";

/** Live, or a replay of a time range at a playhead. */
export type MapClock =
  | { kind: "live" }
  | {
      kind: "replay";
      from: number;
      to: number;
      at: number;
      /** Recorded milliseconds per real one: 60 plays an hour in a minute. */
      speed: number;
      /**
       * How long somebody stays on the replayed map after their last step. A
       * week played at 600x needs longer than a day at 60x, or the swarm is
       * empty between steps. Absent means the engine's own default.
       */
      idleMs?: number;
    };

/** Semantic zoom levels, far to near. */
export type ZoomLevel = "all" | "workspace" | "folders" | "notes";

/** Where the camera is, for the breadcrumb, zoom control and overview map. */
export type CameraInfo = {
  level: ZoomLevel;
  /** 0 (all workspaces) .. 1 (closest), log-scaled. */
  zoom: number;
  /** Breadcrumb from far to near, e.g. ["All workspaces", "Supa", "Projects", "Context launch"]. */
  trail: string[];
};
