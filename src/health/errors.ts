export class HealthStoreError extends Error {
  constructor(
    readonly code: "busy" | "unsafe" | "invalid" | "io" | "capacity" | "transaction",
    message: string,
  ) {
    super(message);
    this.name = "HealthStoreError";
  }
}
