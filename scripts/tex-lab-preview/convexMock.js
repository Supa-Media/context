// The Lab preview's stand-in for convex/react: staff, an empty shared list, and saves that land nowhere.
// One answer object, so an effect keyed on it runs once rather than on every render.
const SHARED = { me: "preview", names: {}, versions: [], caseEdits: [] };
export const useQuery = (ref, args) => {
  if (args === "skip") return undefined;
  const name = String(ref?.[Symbol.for("functionName")] ?? ref ?? "");
  if (name.includes("texLabToolStats")) return globalThis.__labToolStats;
  if (name.includes("amIAdmin")) return true;
  if (name.includes("texLab")) return SHARED;
  return undefined;
};
export const useMutation = () => async () => null;
export const useAction = () => async () => null;
const client = { query: async () => null, mutation: async () => null, action: async () => null };
export const useConvex = () => client;
export const ConvexProviderWithAuth = ({ children }) => children;
export const ConvexReactClient = class {};
