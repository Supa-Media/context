/**
 * The five steps a move out of managed storage walks, as the owner reads them.
 *
 * The backend records four phases (`count`, `copy`, `verify_source`,
 * `verify_target`) plus whether the destination was checked empty and whether
 * the last pass is ready to switch. People read five plain steps instead:
 * checking the bucket, counting, copying, checking every file, switching over.
 * Pure, so the mapping is tested without drawing anything.
 */

export type HandoffStepState = "done" | "current" | "todo";

export interface HandoffStep {
  key: "check" | "count" | "copy" | "verify" | "switch";
  label: string;
  state: HandoffStepState;
  /** Files done and files in all, for the one step that has a bar. */
  progress?: { done: number; total: number };
}

export interface HandoffProgress {
  phase?: "count" | "copy" | "verify_source" | "verify_target";
  claimed?: boolean;
  total?: number;
  processed?: number;
  readyToSwitch?: boolean;
}

const ORDER: HandoffStep["key"][] = ["check", "count", "copy", "verify", "switch"];

function currentStep(progress: HandoffProgress): HandoffStep["key"] {
  if (progress.readyToSwitch === true) return "switch";
  switch (progress.phase) {
    case "copy":
      return "copy";
    case "verify_source":
    case "verify_target":
      return "verify";
    default:
      // A move started before the empty check existed never records a claim,
      // and is already past checking once it is counting.
      return progress.claimed === false ? "check" : "count";
  }
}

function files(count: number): string {
  return count === 1 ? "1 file" : `${count.toLocaleString("en-US")} files`;
}

export function handoffSteps(progress: HandoffProgress): HandoffStep[] {
  const current = currentStep(progress);
  const at = ORDER.indexOf(current);
  const total = progress.total;
  const bar =
    total !== undefined && total > 0
      ? { done: Math.min(progress.processed ?? 0, total), total }
      : undefined;
  return ORDER.map((key, index): HandoffStep => {
    const state: HandoffStepState = index < at ? "done" : index === at ? "current" : "todo";
    switch (key) {
      case "check":
        return {
          key,
          state,
          label: state === "done" ? "Checked your bucket" : "Checking your bucket",
        };
      case "count":
        return {
          key,
          state,
          label:
            state === "done" && total !== undefined
              ? `Counted ${files(total)}`
              : state === "current"
                ? "Counting files"
                : "Count files",
        };
      case "copy":
        return {
          key,
          state,
          label:
            state === "done" && total !== undefined
              ? `Copied ${files(total)}`
              : state === "current"
                ? "Copying"
                : "Copy files",
          progress: state === "current" ? bar : undefined,
        };
      case "verify":
        return {
          key,
          state,
          label:
            state === "done"
              ? "Checked every file matches"
              : state === "current"
                ? "Checking every file matches"
                : "Check every file matches",
          progress: state === "current" ? bar : undefined,
        };
      case "switch":
        return { key, state, label: state === "current" ? "Switching over" : "Switch over" };
    }
  });
}
