/** Types for `areaRoutineTemplates.cjs`; see that file for the reasons. */

export interface AreaRoutineTemplate {
  readonly key: string;
  readonly mode: string | null;
  readonly folder: string;
  readonly name: string;
  readonly at: string;
  readonly on: string | null;
  readonly title: string;
  readonly job: string;
}

export declare const IMPROVE_METRIC: AreaRoutineTemplate;
export declare const MODE_TEMPLATES: readonly AreaRoutineTemplate[];
export declare function pulseTemplates(modes: readonly string[] | null | undefined): AreaRoutineTemplate[];
export declare function templatePath(area: string, template: AreaRoutineTemplate): string;
export declare function templateText(template: AreaRoutineTemplate): string;
