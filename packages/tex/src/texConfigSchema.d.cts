/** Types for `texConfigSchema.cjs`; see that file for the schema, its version and its migrations. */
export declare const SCHEMA_VERSION: number;
/** The Lab's pages a step may live on; a step with no `graph` is on "texting". */
export declare const GRAPHS: readonly ["texting", "nightly"];
export type TexGraphName = (typeof GRAPHS)[number];
export declare function graphOf(node: { graph?: string } | null | undefined): TexGraphName;
export declare const MODES: readonly string[];
export declare const EFFORTS: readonly string[];
export declare const ALLOW: readonly string[];
export declare const KINDS: readonly string[];
export declare const IO_TYPES: readonly string[];
export declare const GROUP_FIELDS: readonly string[];
export declare const NODE_FIELDS: readonly string[];
export declare const EDGE_FIELDS: readonly string[];
export declare function configProblems(config: unknown): string[];
export declare function texConfigOf<T>(config: T): T;
export declare const MIGRATIONS: readonly (<G>(graph: G) => G)[];
export declare function migrateGraph<G>(graph: G): G;
