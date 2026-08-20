/**
 * TypeScript Policy Enforcement Point Adapter Types for PurposeMesh
 *
 * TECHNICAL PREVIEW — This local adapter demonstrates the PurposeMesh evaluation
 * API and is not a full AuthZEN conformant implementation. Production use requires
 * a conformant adapter with published, target-version-scoped passing evidence.
 */

/** Actions supported by PurposeMesh authorization model. */
export type Action = "view" | "operate" | "rotate" | "administer" | "audit";

/** Subject requesting authorization — user or workload identity. */
export type EvaluationSubject = {
  id: string;
  type?: "user" | "workload";
};

/** Action being evaluated. */
export type EvaluationAction = {
  name: Action;
};

/** Resource the action applies to. */
export type EvaluationResource = {
  id: string;
  type?: "dataset";
};

/** Evaluation context — purpose and optional record identifier. */
export type EvaluationContext = {
  purpose: string;
  recordId?: string;
};

/** Full AuthZEN-shaped evaluation request. */
export type EvaluationRequest = {
  subject: EvaluationSubject;
  action: EvaluationAction;
  resource: EvaluationResource;
  context: EvaluationContext;
};

/** Obligations returned in a successful (allow) evaluation response. */
export type Obligations = {
  allowedFields: string[];
  denyFields: string[];
  contractIds: string[];
  capsuleIds: string[];
  policyVersion?: string;
};

/** PEP evaluation decision result. */
export type EvaluationDecision = {
  decision: boolean;
  context: {
    reason: string;
    obligations: Obligations;
  };
};

/** Server-projected record — only authorized fields present. */
export type ProjectedRecord = {
  id: string;
  datasetId: string;
  classification: string;
  attrs: Record<string, unknown>;
  contractId: string;
  capsuleId: string;
};

/** PEP adapter configuration. */
export type PepAdapterConfig = {
  /** PurposeMesh API base URL. */
  baseUrl: string;
  /** Bearer token for authentication. */
  bearerToken: string;
  /** Request identifier for tracing (never logged with secrets). */
  requestId?: string;
};

/** Deny result with typed reason code. */
export type DenyResult = {
  effect: "deny";
  reason: DenyReason;
  requestId?: string;
};

/** Allow result with server-projected data. */
export type AllowResult = {
  effect: "allow";
  records: ProjectedRecord[];
  obligations: Obligations;
  requestId?: string;
};

/** PEP enforcement result — either allow with projected data or deny with reason. */
export type EnforcementResult = DenyResult | AllowResult;

/** Deny reasons recognized by the PEP adapter. */
export type DenyReason =
  | "missing_obligations"
  | "unknown_obligation"
  | "malformed_response"
  | "unsupported_obligation"
  | "api_error"
  | "network_error"
  | "subject_mismatch"
  | "resource_unknown"
  | "record_unknown"
  | "no_contract_binding"
  | "purpose_mismatch"
  | "predicate_miss"
  | "classification_ceiling"
  | "persona_lacks_verb"
  | "principal_inactive"
  | "evaluation_denied";
