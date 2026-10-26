export class HealthStoreError extends Error {
  readonly diagnosticCode?: "ANTIGRAVITY_HEALTH_BUSY";

  constructor(
    readonly code: "busy" | "unsafe" | "invalid" | "io" | "capacity" | "transaction",
    message: string,
  ) {
    super(message);
    this.name = "HealthStoreError";
    if (code === "busy") this.diagnosticCode = "ANTIGRAVITY_HEALTH_BUSY";
  }
}
