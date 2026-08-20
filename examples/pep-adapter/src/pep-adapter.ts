/**
 * TypeScript Policy Enforcement Point Adapter for PurposeMesh
 *
 * TECHNICAL PREVIEW — This local adapter demonstrates the PurposeMesh evaluation
 * API and server-side field projection. It is not a full AuthZEN conformant
 * implementation. Production deployment requires:
 *
 * - A conformant adapter with published, target-version-scoped passing evidence
 * - Enterprise OIDC/BFF authentication (not demo tokens)
 * - Apply, revoke, read-back, drift, and rollback testing
 *
 * This example treats UI visibility as untrusted and delegates all authorization
 * decisions to the PurposeMesh PDP. The browser never decides what data to show;
 * the server returns only server-projected records that the subject is authorized
 * to access.
 *
 * @example
 * ```ts
 * const adapter = createPepAdapter({
 *   baseUrl: "http://127.0.0.1:8787",
 *   bearerToken: token,
 *   requestId: crypto.randomUUID(),
 * });
 *
 * const result = await adapter.enforceDataAccess({
 *   subject: { id: "emma.acme", type: "user" },
 *   action: { name: "view" },
 *   resource: { id: "bw_vendor", type: "dataset" },
 *   context: { purpose: "vendor-performance" },
 * });
 *
 * if (result.effect === "deny") {
 *   console.log(`Access denied: ${result.reason}`);
 * } else {
 *   // result.records contains only server-projected fields
 *   console.log(`Authorized ${result.records.length} records`);
 * }
 * ```
 */

import type {
  DenyReason,
  DenyResult,
  EnforcementResult,
  EvaluationDecision,
  EvaluationRequest,
  Obligations,
  PepAdapterConfig,
  ProjectedRecord,
} from "./types.js";

const SUPPORTED_OBLIGATION_KEYS: ReadonlySet<string> = new Set([
  "allowedFields",
  "denyFields",
  "contractIds",
  "capsuleIds",
  "policyVersion",
]);

const KNOWN_DENY_REASONS: ReadonlySet<string> = new Set([
  "subject_type_mismatch",
  "resource_unknown",
  "record_unknown",
  "no_contract_binding",
  "purpose_mismatch",
  "predicate_miss",
  "classification_ceiling",
  "persona_lacks_verb",
  "principal_inactive",
  "contract_classification_limit",
  "dataset_unknown",
  "dataset_field_allowlist_missing",
  "no_capsule_membership",
  "purpose_required",
  "control_plane_capsule_required",
  "control_plane_admin_required",
  "control_plane_verb_required",
  "jit_persona_inactive",
  "jit_classification_limit",
  "jit_predicate_miss",
  "jit_field_allowlist_empty",
  "contract_field_allowlist_empty",
  "record_required",
  "record_dataset_mismatch",
  "persona_missing",
  "invalid_time",
]);

function isDenyReason(value: unknown): value is DenyReason {
  return typeof value === "string" && KNOWN_DENY_REASONS.has(value);
}

function deny(reason: DenyReason, requestId?: string): DenyResult {
  return { effect: "deny", reason, requestId };
}

function hasUnknownObligations(obligations: Record<string, unknown>): boolean {
  return Object.keys(obligations).some((key) => !SUPPORTED_OBLIGATION_KEYS.has(key));
}

function isValidObligations(value: unknown): value is Obligations {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.allowedFields)) return false;
  if (!Array.isArray(obj.denyFields)) return false;
  if (!Array.isArray(obj.contractIds)) return false;
  if (!Array.isArray(obj.capsuleIds)) return false;
  if (obj.policyVersion !== undefined && typeof obj.policyVersion !== "string") return false;
  return true;
}

function isValidEvaluationResponse(value: unknown): value is EvaluationDecision {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.decision !== "boolean") return false;
  if (obj.context === null || typeof obj.context !== "object") return false;
  const ctx = obj.context as Record<string, unknown>;
  if (typeof ctx.reason !== "string") return false;
  if (ctx.obligations === undefined) return false;
  return true;
}

function isValidDataResponse(value: unknown): value is {
  decision: { effect: "allow" | "deny"; reason: string };
  records: ProjectedRecord[];
} {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (!obj.decision || typeof obj.decision !== "object") return false;
  if (!Array.isArray(obj.records)) return false;
  return true;
}

export type PepAdapter = {
  /**
   * Evaluate an authorization request against PurposeMesh and return the
   * PDP decision. This is a low-level call that returns the raw evaluation
   * response without data projection.
   */
  evaluate(request: EvaluationRequest): Promise<EvaluationDecision | DenyResult>;

  /**
   * Enforce data access by:
   * 1. Evaluating the request against PurposeMesh
   * 2. On allow, fetching server-projected records
   * 3. On deny or any error, returning a deny result
   *
   * The returned records contain only fields the subject is authorized to see.
   * Field projection is performed server-side; the PEP does not filter locally.
   */
  enforceDataAccess(request: EvaluationRequest): Promise<EnforcementResult>;

  /**
   * The request identifier for this adapter instance. Propagated to
   * PurposeMesh for tracing but never logged with bearer tokens or
   * sensitive record content.
   */
  requestId: string | undefined;
};

/**
 * Create a Policy Enforcement Point adapter for PurposeMesh.
 *
 * TECHNICAL PREVIEW — This adapter demonstrates integration patterns but is
 * not a conformant AuthZEN implementation. It enforces:
 *
 * - Server-side field projection (never client-side hiding)
 * - Missing, unknown, malformed, and unsupported obligations treated as deny
 * - Request identifier propagation for tracing
 * - No logging of bearer tokens or sensitive record content
 *
 * @param config - Adapter configuration
 * @returns PEP adapter instance
 */
export function createPepAdapter(config: PepAdapterConfig): PepAdapter {
  const { baseUrl, bearerToken, requestId } = config;

  async function fetchJson<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<{ ok: true; data: T } | { ok: false; status: number; error?: string }> {
    const url = new URL(path, baseUrl);
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          authorization: `Bearer ${bearerToken}`,
          "content-type": "application/json",
          ...(requestId ? { "x-request-id": requestId } : {}),
        },
      });
      if (!response.ok) {
        const body = await response.text();
        let error: string | undefined;
        try {
          const parsed = JSON.parse(body);
          error = typeof parsed?.error === "string" ? parsed.error : undefined;
        } catch {
          // Ignore JSON parse errors
        }
        return { ok: false, status: response.status, error };
      }
      const data = await response.json();
      return { ok: true, data: data as T };
    } catch (error) {
      return { ok: false, status: 0, error: error instanceof Error ? error.message : "network error" };
    }
  }

  async function evaluate(request: EvaluationRequest): Promise<EvaluationDecision | DenyResult> {
    const result = await fetchJson<unknown>("/access/v1/evaluation", {
      method: "POST",
      body: JSON.stringify(request),
    });

    if (!result.ok) {
      if (result.status === 0) return deny("network_error", requestId);
      if (result.status === 403) return deny("subject_mismatch", requestId);
      return deny("api_error", requestId);
    }

    if (!isValidEvaluationResponse(result.data)) {
      return deny("malformed_response", requestId);
    }

    const { decision, context } = result.data;
    const { reason, obligations } = context;

    if (!decision) {
      const denyReason = isDenyReason(reason) ? reason : "evaluation_denied";
      return deny(denyReason, requestId);
    }

    if (!obligations) {
      return deny("missing_obligations", requestId);
    }

    if (!isValidObligations(obligations)) {
      return deny("malformed_response", requestId);
    }

    if (hasUnknownObligations(obligations as Record<string, unknown>)) {
      return deny("unknown_obligation", requestId);
    }

    return result.data;
  }

  async function enforceDataAccess(request: EvaluationRequest): Promise<EnforcementResult> {
    const evalResult = await evaluate(request);

    if ("effect" in evalResult && evalResult.effect === "deny") {
      return evalResult;
    }

    if (!("decision" in evalResult) || !evalResult.decision) {
      return deny("evaluation_denied", requestId);
    }

    const { obligations } = evalResult.context;

    const dataResult = await fetchJson<unknown>(
      `/api/data/${encodeURIComponent(request.resource.id)}?purpose=${encodeURIComponent(request.context.purpose)}`,
      { method: "GET" },
    );

    if (!dataResult.ok) {
      if (dataResult.status === 0) return deny("network_error", requestId);
      if (dataResult.status === 404) return deny("resource_unknown", requestId);
      return deny("api_error", requestId);
    }

    if (!isValidDataResponse(dataResult.data)) {
      return deny("malformed_response", requestId);
    }

    const { records } = dataResult.data;

    return {
      effect: "allow",
      records,
      obligations,
      requestId,
    };
  }

  return {
    evaluate,
    enforceDataAccess,
    requestId,
  };
}
