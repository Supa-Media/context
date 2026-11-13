// The Lab preview's stand-in for convex/react: staff, an empty shared list, and saves that land nowhere.
export const useQuery = (ref, args) => {
  if (args === "skip") return undefined;
  const name = String(ref?.[Symbol.for("functionName")] ?? ref ?? "");
  if (name.includes("amIAdmin")) return true;
  if (name.includes("texLab")) return { me: "preview", versions: [], caseEdits: [] };
  return undefined;
};
export const useMutation = () => async () => null;
export const useAction = () => async () => null;
