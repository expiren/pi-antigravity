export type HealthStatus =
  "hard_quota" | "transient_429" | "auth_error" | "temporary_unavailable" | "unknown";

export interface HealthScope {
  accountId: string;
  projectId: string;
  model: string;
}

/** Closed codes are the only provider-derived text permitted in the store. */
export const HEALTH_REASONS = [
  "quota_exhausted",
  "rate_limited",
  "authentication_required",
  "authorization_denied",
  "request_timeout",
  "endpoint_unavailable",
  "provider_unavailable",
  "unknown",
] as const;

export type HealthReason = (typeof HEALTH_REASONS)[number];

export interface HealthRecord extends HealthScope {
  status: HealthStatus;
  reason: string;
  observedAt: number;
  cooldownUntil: number;
  retryAfterUntil?: number;
  responseStatus?: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  attemptOrder?: number;
  projectWide?: boolean;
}

export interface HealthState {
  version: 1;
  updatedAt: number;
  sequence: number;
  records: Record<string, HealthRecord>;
  reservations: Record<
    string,
    {
      id: string;
      accountId: string;
      projectId: string;
      model: string;
      until: number;
      ownerPid: number;
    }
  >;
}

export interface HealthFailure {
  status: Exclude<HealthStatus, "unknown">;
  reason: string;
  cooldownUntil: number;
  retryAfterUntil?: number;
  responseStatus?: number;
  projectWide: boolean;
  global: boolean;
}
