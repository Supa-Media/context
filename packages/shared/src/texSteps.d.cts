/** Types for `texSteps.cjs`; see that file. */

export interface TexStepDef {
  /** The texConfig node id. */
  id: string;
  label: string;
  /** The texConfig model key (`models` in the json). */
  model: string;
  on: boolean;
}

export declare const TEX_STEPS: readonly TexStepDef[];
export declare function texStepForModel(model: string): string | null;
