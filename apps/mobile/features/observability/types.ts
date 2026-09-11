export type TelemetryProperties = Record<string, string | number | boolean | null>;

/** The deliberately tiny common surface used by the native and web clients. */
export interface AnalyticsClient {
  ready(): Promise<void>;
  capture(name: string, properties?: TelemetryProperties): void;
  screen(name: string): void;
  identify(userId: string): void;
  reset(): void;
  getSessionId(): string;
}
