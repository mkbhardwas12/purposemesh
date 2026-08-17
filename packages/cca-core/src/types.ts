export type PersonaId = string;

export type Action = "view" | "operate" | "rotate" | "administer" | "audit";

export type Classification = "internal" | "confidential" | "restricted";

export type DecisionEffect = "allow" | "deny";

export type Predicate =
  | { op: "true" }
  | { op: "eq"; field: string; value: unknown }
  | { op: "in"; field: string; values: unknown[] }
  | { op: "fromCapsuleAttr"; field: string; attr: string }
  | { op: "and"; clauses: Predicate[] }
  | { op: "or"; clauses: Predicate[] };

export type Persona = {
  id: PersonaId;
  label: string;
  actions: Action[];
  ceiling: Classification | "none";
  /** Built-in persona this custom role still satisfies (avoids breaking prior contracts). */
  inherits?: PersonaId;
};

export type Capsule = {
  id: string;
  label: string;
  purpose: string;
  parentId?: string;
  active: boolean;
  attrs: Record<string, unknown>;
};

export type Principal = {
  id: string;
  displayName: string;
  username: string;
  passwordHash: string;
  personaId: PersonaId;
  kind: "human" | "workload";
  disabled: boolean;
};

export type Membership = {
  principalId: string;
  capsuleId: string;
  /** Capability profile for this relationship. Older snapshots fall back to Principal.personaId. */
  personaId?: PersonaId;
  /** Stable lifecycle identity. Legacy v3 snapshots may omit it until the assignment is replaced. */
  assignmentId?: string;
};

export type Dataset = {
  id: string;
  name: string;
  origin: string;
  design: string;
  classification: Classification;
  controlPlane: boolean;
  /** Exhaustive set of record attribute paths that may leave the PDP. */
  allowedFields: string[];
  /** Principals accountable for approving access to this governed data product. */
  ownerPrincipalIds?: string[];
};

export type Contract = {
  id: string;
  datasetId: string;
  purpose: string;
  allowedPersonas: PersonaId[];
  actions: Action[];
  classificationMax: Classification;
  predicate: Predicate;
  /** Optional contract-level projection. Omission means the dataset allowlist. */
  allowFields?: string[];
  denyFields: string[];
  /** Contracts marked approvalRequired are templates for JIT and never grant standing access. */
  approvalRequired?: boolean;
};

export type Binding = {
  id: string;
  capsuleId: string;
  contractId: string;
};

export type RecordRow = {
  id: string;
  datasetId: string;
  classification: Classification;
  attrs: Record<string, unknown>;
};

export type JitGrant = {
  id: string;
  requesterId: string;
  approverId?: string;
  principalId: string;
  datasetId: string;
  capsuleId: string;
  personaId: PersonaId;
  contractId: string;
  purpose: string;
  /** Actions elevated by this grant. JIT never implies every persona action. */
  actions: Action[];
  /** Field obligations applied to every record released through this grant. */
  denyFields: string[];
  /** Dataset allowlist captured when the grant was requested; later schema growth cannot widen it. */
  allowedFields: string[];
  /** Frozen row scope and capsule attributes; later policy edits cannot widen a live grant. */
  predicate: Predicate;
  capsuleAttrs: Record<string, unknown>;
  classificationMax: Classification;
  policyVersion: string;
  requestContext: {
    justification: string;
    requestedTtlMs: number;
    ticket?: string;
    authenticationAssurance?: string;
  };
  approvalContext?: {
    approvedAt: number;
    approvedBy: string;
    ttlMs: number;
    authenticationAssurance?: string;
  };
  status: "pending" | "approved" | "denied" | "expired" | "revoked";
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  revokedBy?: string;
  revocationReason?: string;
  deniedAt?: number;
  deniedBy?: string;
  denialReason?: string;
};

export type AuditEvent = {
  seq: number;
  at: number;
  actorId: string;
  type: string;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
};

export type CheckInput = {
  principalId: string;
  action: Action;
  datasetId: string;
  record?: RecordRow;
  purpose?: string;
  now?: number;
};

export type Decision = {
  effect: DecisionEffect;
  reason: string;
  contractId?: string;
  capsuleId?: string;
  /** All contracts/capsules that contributed to a combined allow decision. */
  contractIds?: string[];
  capsuleIds?: string[];
  /** Exhaustive record attribute paths eligible for release before deny obligations. */
  allowedFields: string[];
  denyFields: string[];
  jitId?: string;
};

export type FilteredRecord = {
  id: string;
  datasetId: string;
  classification: Classification;
  attrs: Record<string, unknown>;
  contractId: string;
  capsuleId: string;
};

export type Clock = () => number;

export const CLASS_RANK: Record<Classification, number> = {
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export const ACTION_RANK: Record<Action, number> = {
  view: 1,
  audit: 1,
  operate: 2,
  rotate: 3,
  administer: 4,
};
