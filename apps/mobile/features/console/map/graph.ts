import type { GraphKind } from "../../design/tokens";
import {
  clientPosition,
  contextPosition,
  type MapEdge,
  type MapGraph,
  type MapNode,
} from "./layout";

/** Node radii, straight from the mockup's `NODES` table. */
export const NODE_RADIUS = {
  you: 26,
  /** A context you own is drawn largest — it is the centre of gravity. */
  own: 34,
  team: 24,
  shared: 22,
  client: 12,
} as const;

export interface ContextInput {
  id: string;
  /** "@seyi" — the addressable name, shown as the node label. */
  label: string;
  /** "1,102 notes · owner" — the grey second line. */
  sub?: string;
  /** How you reach it: your own, granted to you, or a shared workspace. */
  kind: Extract<GraphKind, "own" | "team" | "shared">;
}

export interface ClientInput {
  id: string;
  label: string;
  /** The context that granted this client access. */
  contextId: string;
}

export const YOU_NODE_ID = "you";

/**
 * Builds the constellation from live data.
 *
 * The shape is the mockup's: you at the centre, contexts orbiting, and AI
 * clients hanging off *whichever context granted them* rather than off you —
 * that placement is the point of the picture. A grant belongs to a workspace,
 * so revoking one client cannot silently reach another context.
 *
 * Clients whose `contextId` is not in `contexts` are skipped: a grant on a
 * workspace you cannot see must not put a floating node on the map.
 */
export function buildConstellation({
  selfLabel = "You",
  contexts,
  clients,
}: {
  selfLabel?: string;
  contexts: ContextInput[];
  clients: ClientInput[];
}): MapGraph {
  const nodes: MapNode[] = [
    {
      id: YOU_NODE_ID,
      x: 0.5,
      y: 0.5,
      r: NODE_RADIUS.you,
      label: selfLabel,
      kind: "you",
    },
  ];
  const edges: MapEdge[] = [];

  const known = new Set(contexts.map((c) => c.id));
  const clientsByContext = new Map<string, ClientInput[]>();
  for (const client of clients) {
    if (!known.has(client.contextId)) continue;
    const bucket = clientsByContext.get(client.contextId);
    if (bucket) bucket.push(client);
    else clientsByContext.set(client.contextId, [client]);
  }

  contexts.forEach((context, index) => {
    const position = contextPosition(index, contexts.length);
    nodes.push({
      id: context.id,
      x: position.x,
      y: position.y,
      r: NODE_RADIUS[context.kind],
      label: context.label,
      sub: context.sub,
      kind: context.kind,
    });
    edges.push({ from: YOU_NODE_ID, to: context.id, kind: context.kind });

    const attached = clientsByContext.get(context.id) ?? [];
    attached.forEach((client, clientIndex) => {
      const clientPos = clientPosition(index, contexts.length, clientIndex, attached.length);
      nodes.push({
        id: client.id,
        x: clientPos.x,
        y: clientPos.y,
        r: NODE_RADIUS.client,
        label: client.label,
        kind: "client",
      });
      edges.push({ from: context.id, to: client.id, kind: "client" });
    });
  });

  return { nodes, edges };
}

/**
 * Maps a Convex membership role onto the relationship the map draws.
 *
 * A `shared` workspace stays shared whatever your role in it, because the
 * picture is about who else is in the room. Owning a personal workspace is your
 * own context; anything else is access somebody granted you.
 */
export function contextKindFor(role: string, kind: string): ContextInput["kind"] {
  if (kind === "shared") return "shared";
  if (role === "owner") return "own";
  return "team";
}
