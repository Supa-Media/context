/** Types for `texNodeSettings.cjs`: the settings a Tex code step declares, read by the gateway and drawn by the Lab. */
export type StepSettingValue = number | boolean | string;
export type StepSettingDecl =
  | { type: "number"; default: number; min: number; max: number; integer?: boolean; unit?: string; label: string; tip: string }
  | { type: "boolean"; default: boolean; label: string; tip: string }
  | { type: "choice"; default: string; options: readonly { value: string; label: string }[]; label: string; tip: string };
export declare const TYPES: readonly ["number", "boolean", "choice"];
export declare const STEP_SETTINGS: Readonly<Record<string, Readonly<Record<string, StepSettingDecl>>>>;
export declare function stepSettingProblem(id: string, name: string, value: unknown): string | null;
export declare function stepSettingsProblems(id: string, settings: unknown): string[];
export declare function stepSettings(config: { nodes?: readonly { id: string; settings?: Record<string, unknown> }[] } | null | undefined, id: string): Record<string, StepSettingValue>;
export declare function declarationProblems(table?: Readonly<Record<string, Readonly<Record<string, StepSettingDecl>>>>): string[];
