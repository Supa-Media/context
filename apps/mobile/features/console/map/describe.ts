import type { MapGraph } from "./layout";

/**
 * A one-sentence description of the constellation, for anyone who cannot see it.
 *
 * The map carries real information — which contexts you can reach and which AI
 * clients are attached to each — so it is announced as an image with a text
 * alternative rather than hidden as decoration.
 */
export function describeGraph(graph: MapGraph): string {
  const contexts = graph.nodes.filter(
    (node) => node.kind !== "you" && node.kind !== "client",
  );
  const clients = graph.nodes.filter((node) => node.kind === "client");

  if (contexts.length === 0) {
    return "Map of your context. Nothing is connected yet.";
  }

  const contextNames = contexts.map((node) => node.label).join(", ");
  const clientPart =
    clients.length === 0
      ? "No AI clients are connected."
      : `${clients.length} AI client${clients.length === 1 ? "" : "s"} connected: ` +
        `${clients.map((node) => node.label).join(", ")}.`;

  return (
    "Map of your context. You are at the centre, connected to " +
    `${contexts.length} ${contexts.length === 1 ? "place" : "places"}: ${contextNames}. ` +
    clientPart
  );
}
