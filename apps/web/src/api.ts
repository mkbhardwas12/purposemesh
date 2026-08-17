export type Principal = {
  id: string;
  username: string;
  displayName: string;
  personaId: string;
  personaLabel?: string;
  kind: string;
  capsules: { id: string; label: string; purpose: string }[];
  assignments?: Array<{
    capsuleId: string;
    capsuleLabel: string;
    purpose: string;
    personaId: string;
    personaLabel: string;
    inherits?: string;
    actions: string[];
    ceiling: string;
  }>;
  actions: string[];
  ceiling?: string;
  inherits?: string;
};

export type Decision = {
  effect: "allow" | "deny";
  reason: string;
  contractId?: string;
  capsuleId?: string;
  denyFields: string[];
};

export type Surface = {
  datasetId: string;
  datasetName: string;
  effect: "allow" | "deny";
  reason: string;
  rowCount: number;
  contractId?: string;
};

export type RecordRow = {
  id: string;
  datasetId: string;
  classification: string;
  attrs: Record<string, unknown>;
  contractId: string;
  capsuleId: string;
};

export type WarehouseFacet = {
  key: string;
  count: number;
};

export type WarehouseLineage = {
  pipelineId: string;
  pipelineName: string;
  sourceSystem: string;
  targetSystem: string;
  count: number;
};

export type WarehouseReceipt = {
  subjectId: string;
  personaId: string;
  tokenPersonaId: string;
  effectiveAssignments: Array<{
    capsuleId: string;
    capsuleLabel: string;
    personaId: string;
    personaLabel: string;
  }>;
  effect: "allow" | "deny";
  reason: string;
  contractIds: string[];
  capsuleIds: string[];
  allowedFields: string[];
  denyFields: string[];
  protectedFieldCount: number;
  auditSeq?: number;
  auditHash?: string;
};

export type WarehouseRecordsPage = {
  dataset: {
    id: string;
    name: string;
    origin: string;
    design?: string;
    classification: string;
    allowedFields?: string[];
  };
  purpose: string;
  visible: number;
  /** Returned only when the active policy authorizes global cardinality. */
  total?: number;
  records: Array<Record<string, unknown>>;
  nextCursor?: number;
  facets: {
    products: WarehouseFacet[];
    tenants: WarehouseFacet[];
    regions: WarehouseFacet[];
    departments: WarehouseFacet[];
    sensitivities: WarehouseFacet[];
    sources: WarehouseFacet[];
  };
  lineage: WarehouseLineage[];
  receipt: WarehouseReceipt;
};

export type Catalog = {
  personas: { id: string; label: string; actions: string[]; ceiling: string }[];
  capsules: {
    id: string;
    label: string;
    purpose: string;
    active: boolean;
    parentId?: string;
    attrs?: Record<string, unknown>;
  }[];
  datasets: {
    id: string;
    name: string;
    origin: string;
    design?: string;
    classification: string;
    controlPlane: boolean;
    allowedFields?: string[];
  }[];
  contracts: {
    id: string;
    datasetId: string;
    purpose: string;
    allowedPersonas?: string[];
    actions?: string[];
    classificationMax?: string;
    predicate?: Record<string, unknown>;
    allowFields?: string[];
    denyFields?: string[];
    approvalRequired?: boolean;
  }[];
  bindings: { id: string; capsuleId: string; contractId: string }[];
  principals: {
    id: string;
    displayName: string;
    username: string;
    personaId: string;
    kind: string;
    disabled?: boolean;
  }[];
  memberships: { principalId: string; capsuleId: string; personaId?: string }[];
  features?: {
    /** Demo-only destructive reset. Always false for scoped and production catalogs. */
    demoReset: boolean;
  };
};

export type CapabilityGate = {
  target: "elasticsearch" | "bw" | "bobj" | "dashboard" | "adf";
  contractId: string;
  datasetId: string;
  required: string[];
  supported: string[];
  missing: string[];
  status: "eligible" | "blocked";
  reason?: string;
};

export type CompiledPolicy = {
  capsuleId: string;
  policyVersion: string;
  policyHash: string;
  deploymentStatus: "deployable" | "blocked";
  previewOnly: boolean;
  assignments: Array<{
    principalId: string;
    personaId: string;
    kind: "human" | "workload";
    contractIds: string[];
    actions: string[];
  }>;
  capabilityGates: CapabilityGate[];
  plan: {
    apply: Array<{ target: string; artifactId: string; operation: "upsert" }>;
    revoke: Array<{ target: string; artifactId: string; operation: "delete" }>;
    readback: Array<{ target: string; artifactId: string; verify: "policy_hash_and_assignments" }>;
  };
  elasticsearch: Array<{
    name: string;
    indices: Array<{
      names: string[];
      privileges: string[];
      query: Record<string, unknown>;
      field_security: { grant: string[]; except: string[] };
    }>;
  }>;
  bw: Array<{
    name: string;
    infoProvider: string;
    characteristics: Array<{ infoObject: string; values: unknown[] }>;
  }>;
  bobj: { groups: string[]; folders: string[] };
  dashboards: { spaces: string[] };
  adf: { identities: string[]; vaultPaths: string[] };
};

export type DirectoryUser = {
  username: string;
  persona: string;
  capsule: string;
  displayName?: string;
};

export type JitGrant = {
  id: string;
  requesterId: string;
  principalId: string;
  datasetId: string;
  capsuleId: string;
  personaId?: string;
  contractId: string;
  purpose: string;
  actions: string[];
  denyFields: string[];
  allowedFields: string[];
  predicate: Record<string, unknown>;
  capsuleAttrs: Record<string, unknown>;
  classificationMax: string;
  policyVersion: string;
  requestContext: {
    justification: string;
    requestedTtlMs: number;
    ticket?: string;
    authenticationAssurance?: string;
  };
  approvalContext?: {
    approvedAt: number | string;
    approvedBy: string;
    ttlMs: number;
    authenticationAssurance?: string;
  };
  /** Legacy response aliases retained during migration to requestContext. */
  justification?: string;
  requestedTtlMs?: number;
  status: "pending" | "approved" | "denied" | "expired" | "revoked";
  createdAt?: number | string;
  expiresAt?: number | string;
  approverId?: string;
  revokedAt?: number | string;
  revokedBy?: string;
  revocationReason?: string;
  deniedAt?: number | string;
  deniedBy?: string;
  denialReason?: string;
};

export type AuditEvent = {
  seq: number;
  at?: number | string;
  type: string;
  actorId: string;
  detail?: Record<string, unknown>;
  hash: string;
  prevHash?: string;
};

export type GovernanceReviewerRole = "data-owner" | "governance-admin";

export type RoleRequestApproval = {
  reviewerId: string;
  reviewerRole: GovernanceReviewerRole;
  decision: "approved" | "denied";
  decidedAt: number | string;
  reason?: string;
};

export type RoleRequest = {
  id: string;
  requesterId: string;
  principalId: string;
  status: "pending" | "approved" | "denied";
  draft: RoleDraft;
  createdAt: number | string;
  approvalPolicyVersion: 1 | 2;
  requiredApprovals: GovernanceReviewerRole[];
  approvals: RoleRequestApproval[];
  reviewedAt?: number | string;
  reviewerId?: string;
  reason?: string;
  applied?: { personaId: string; capsuleId: string; contractId: string };
};

export type SodFact = {
  source: "candidate" | "standing";
  principalId: string;
  purpose: string;
  actions: string[];
  products: string[];
  ceiling: string;
  capsuleId?: string;
  contractId?: string;
};

export type SodViolation = {
  ruleId: string;
  ruleVersion: number;
  title: string;
  severity: "high" | "critical";
  rationale: string;
  remediation: string;
  principalId: string;
  evidence: { left: SodFact; right: SodFact };
};

export type RecertificationCampaignStatus = "active" | "completed" | "expired";
export type RecertificationItemStatus = "pending" | "attested" | "revoked" | "removed";

export type RecertificationCampaignSummary = {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number | string;
  dueAt: number | string;
  cadenceDays: number;
  nextCampaignAt: number | string;
  status: RecertificationCampaignStatus;
  expiryEnforcement: "lazy-on-api-access";
  overdueDecisionPolicy: "blocked";
  previousCampaignId?: string;
  itemCount: number;
  counts: Record<RecertificationItemStatus, number>;
};

export type RecertificationEvidence = {
  auditSeq: number;
  auditHash: string;
  membershipFingerprint: string;
};

export type RecertificationItem = {
  id: string;
  principalId: string;
  capsuleId: string;
  personaId: string;
  assignmentId: string;
  status: RecertificationItemStatus;
  eligibleReviewerRoles: GovernanceReviewerRole[];
  createdAt: number | string;
  decidedAt?: number | string;
  decidedBy?: string;
  reviewerRole?: GovernanceReviewerRole | "system";
  reason?: string;
  evidence?: RecertificationEvidence;
};

export type RecertificationCampaignPage = {
  campaigns: RecertificationCampaignSummary[];
  nextCursor?: number;
  total: number;
};

export type RecertificationItemsPage = {
  campaign: RecertificationCampaignSummary;
  items: RecertificationItem[];
  nextCursor?: number;
  total: number;
};

export type RecertificationEvidenceReport = {
  campaign: RecertificationCampaignSummary;
  decisions: Array<{
    itemId: string;
    principalId: string;
    capsuleId: string;
    personaId: string;
    assignmentId: string;
    status: Exclude<RecertificationItemStatus, "pending">;
    decidedAt: number | string;
    decidedBy: string;
    reviewerRole: GovernanceReviewerRole | "system";
    reason: string;
    evidence: RecertificationEvidence;
  }>;
  auditChainValid: boolean;
};

export type PaginationInput = {
  cursor?: number;
  limit?: number;
};

export type JitGrantPage = {
  grants: JitGrant[];
  nextCursor?: number;
  total: number;
};

export type AuditEventPage = {
  events: AuditEvent[];
  nextCursor?: number;
  total: number;
};

export type RoleRequestPage = {
  requests: RoleRequest[];
  nextCursor?: number;
  total: number;
};

const TOKEN_KEY = "cca.token";
export const UNAUTHORIZED_EVENT = "cca:unauthorized";

export function getToken(): string | null {
  // Tokens are tab-scoped. Remove the legacy persistent copy so an earlier
  // build cannot silently keep a bearer token across browser restarts.
  localStorage.removeItem(TOKEN_KEY);
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  localStorage.removeItem(TOKEN_KEY);
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export function tokenExpiresAt(token: string | null): number | undefined {
  if (!token) return undefined;
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return undefined;
    const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1_000
      : undefined;
  } catch {
    return undefined;
  }
}

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status = 0, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20_000);
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiError(init.signal?.aborted ? "Request cancelled" : "Request timed out");
    }
    throw new ApiError(error instanceof Error ? error.message : "Network request failed");
  } finally {
    window.clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abort);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const payload = body as { error?: string; message?: string; code?: string; details?: unknown };
    if (response.status === 401 && token) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(
      payload.error ?? payload.message ?? `Request failed (HTTP ${response.status})`,
      response.status,
      payload.code,
      payload.details,
    );
  }
  return body as T;
}

function pagedPath(path: string, input: PaginationInput): string {
  const query = new URLSearchParams();
  if (input.cursor !== undefined) query.set("cursor", String(input.cursor));
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export const api = {
  directory: (signal?: AbortSignal) =>
    request<{ password?: string; users: DirectoryUser[] }>("/api/auth/directory", { signal }),
  login: (username: string, password: string, signal?: AbortSignal) =>
    request<{ token: string; principal: Principal }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      signal,
    }),
  me: (signal?: AbortSignal) => request<Principal>("/api/auth/me", { signal }),
  catalog: (signal?: AbortSignal) => request<Catalog>("/api/catalog", { signal }),
  explain: (signal?: AbortSignal) =>
    request<{ surfaces: Surface[] }>("/api/pdp/explain", { signal }),
  data: (datasetId: string, purpose: string, signal?: AbortSignal) =>
    request<{ decision: Decision; records: RecordRow[] }>(
      `/api/data/${encodeURIComponent(datasetId)}?purpose=${encodeURIComponent(purpose)}`,
      { signal },
    ),
  warehouseRecords: (
    input: { purpose: string; cursor?: number; limit?: number },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ purpose: input.purpose });
    if (input.cursor !== undefined) query.set("cursor", String(input.cursor));
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    return request<WarehouseRecordsPage>(`/api/warehouse/records?${query}`, { signal });
  },
  offboard: (capsuleId: string, cascade = false) =>
    request<{
      removedMembers: string[];
      removedBindings: string[];
      expiredJit: string[];
      cascaded: string[];
    }>(
      `/api/capsules/${encodeURIComponent(capsuleId)}/offboard`,
      { method: "POST", body: JSON.stringify({ cascade }) },
    ),
  jitList: (input: PaginationInput = {}, signal?: AbortSignal) =>
    request<JitGrantPage>(pagedPath("/api/jit", input), { signal }),
  jitRequest: (input: {
    datasetId: string;
    capsuleId: string;
    purpose: string;
    contractId?: string;
    justification: string;
    durationMs: number;
    ticket?: string;
  }) => request<JitGrant>("/api/jit", { method: "POST", body: JSON.stringify(input) }),
  jitApprove: (id: string, ttlMs: number) =>
    request<JitGrant>(`/api/jit/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ ttlMs }),
    }),
  jitDeny: (id: string, reason: string) =>
    request<JitGrant>(`/api/jit/${encodeURIComponent(id)}/deny`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  jitRevoke: (id: string, reason: string) =>
    request<JitGrant>(`/api/jit/${encodeURIComponent(id)}/revoke`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  compiler: (capsuleId: string, signal?: AbortSignal) =>
    request<CompiledPolicy>(`/api/compiler/${encodeURIComponent(capsuleId)}`, { signal }),
  audit: (input: PaginationInput = {}, signal?: AbortSignal) =>
    request<AuditEventPage>(pagedPath("/api/audit", input), { signal }),
  reset: () => request<{ ok: boolean }>("/api/store/reset", { method: "POST" }),
  dashboard: (purpose: string, signal?: AbortSignal) =>
    request<DashboardPayload>(`/api/dashboard?purpose=${encodeURIComponent(purpose)}`, { signal }),
  palette: (signal?: AbortSignal) =>
    request<{ palette: RolePalette }>("/api/roles/palette", { signal }),
  previewRole: (draft: RoleDraft, principalId?: string, signal?: AbortSignal) =>
    request<DashboardPayload & { errors: string[]; sodViolations: SodViolation[]; sodEvaluatedPrincipalId: string }>("/api/roles/preview", {
      method: "POST",
      body: JSON.stringify({ draft, principalId }),
      signal,
    }),
  generateFromAsk: (ask: string, signal?: AbortSignal) =>
    request<{
      draft: RoleDraft;
      rationale: string[];
      ask: string;
      preview: DashboardPayload;
      errors?: string[];
      sodViolations: SodViolation[];
    }>("/api/roles/from-ask", {
      method: "POST",
      body: JSON.stringify({ ask }),
      signal,
    }),
  roleRequests: (input: PaginationInput = {}, signal?: AbortSignal) =>
    request<RoleRequestPage>(pagedPath("/api/role-requests", input), { signal }),
  createRoleRequest: (draft: RoleDraft, principalId?: string) =>
    request<RoleRequest>("/api/role-requests", {
      method: "POST",
      body: JSON.stringify({ draft, principalId }),
    }),
  approveRoleRequest: (id: string) =>
    request<RoleRequest>(`/api/role-requests/${encodeURIComponent(id)}/approve`, { method: "POST" }),
  denyRoleRequest: (id: string, reason: string) =>
    request<RoleRequest>(`/api/role-requests/${encodeURIComponent(id)}/deny`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  sodViolations: (input: PaginationInput & { principalId?: string } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (input.principalId) query.set("principalId", input.principalId);
    if (input.cursor !== undefined) query.set("cursor", String(input.cursor));
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.toString();
    return request<{
      violations: SodViolation[];
      nextCursor?: number;
      total: number;
      evaluatedPrincipals: number;
      policyRules: string[];
    }>(`/api/governance/sod/violations${suffix ? `?${suffix}` : ""}`, { signal });
  },
  recertifications: (
    input: PaginationInput & { status?: RecertificationCampaignStatus } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (input.status) query.set("status", input.status);
    if (input.cursor !== undefined) query.set("cursor", String(input.cursor));
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.toString();
    return request<RecertificationCampaignPage>(`/api/recertifications${suffix ? `?${suffix}` : ""}`, { signal });
  },
  createRecertification: (input: { name: string; dueAt: number; cadenceDays: number }) =>
    request<RecertificationCampaignSummary & { items: RecertificationItem[] }>("/api/recertifications", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  renewRecertification: (campaignId: string) =>
    request<RecertificationCampaignSummary & { items: RecertificationItem[] }>(
      `/api/recertifications/${encodeURIComponent(campaignId)}/renew`,
      { method: "POST" },
    ),
  recertificationItems: (
    campaignId: string,
    input: PaginationInput & { status?: RecertificationItemStatus } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (input.status) query.set("status", input.status);
    if (input.cursor !== undefined) query.set("cursor", String(input.cursor));
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.toString();
    return request<RecertificationItemsPage>(
      `/api/recertifications/${encodeURIComponent(campaignId)}/items${suffix ? `?${suffix}` : ""}`,
      { signal },
    );
  },
  recertificationEvidence: (campaignId: string, signal?: AbortSignal) =>
    request<RecertificationEvidenceReport>(
      `/api/recertifications/${encodeURIComponent(campaignId)}/evidence`,
      { signal },
    ),
  decideRecertification: (
    campaignId: string,
    itemId: string,
    decision: "attest" | "revoke",
    reason: string,
  ) => request<{ campaign: RecertificationCampaignSummary; item: RecertificationItem }>(
    `/api/recertifications/${encodeURIComponent(campaignId)}/items/${encodeURIComponent(itemId)}/${decision}`,
    { method: "POST", body: JSON.stringify({ reason }) },
  ),
};

export type RoleDraft = {
  name: string;
  verbs: string[];
  purpose: string;
  ceiling: "internal" | "confidential" | "restricted";
  products: string[];
  tenants: string[];
  regions: string[];
  departments: string[];
  denyFields: string[];
  sources: string[];
};

export type RoleToken = { id: string; label: string; group: string };

export type RolePalette = {
  verbs: RoleToken[];
  purposes: RoleToken[];
  ceilings: RoleToken[];
  products: RoleToken[];
  tenants: RoleToken[];
  regions: RoleToken[];
  departments: RoleToken[];
  masks: RoleToken[];
  sources?: RoleToken[];
};

export type FactRow = {
  id: number;
  product: string;
  tenant: string;
  region: string;
  department: string;
  sensitivity: string;
  amount: number;
  occurred_at: string;
  email?: string;
  account_number?: string;
  payload?: string;
  title: string;
  status: string;
};

export type DashboardPayload = {
  /** Omitted for minimized non-admin responses to avoid global-cardinality disclosure. */
  total?: number;
  visible: number;
  denied: boolean;
  byProduct: { key: string; count: number; amount?: number }[];
  byRegion: { key: string; count: number }[];
  byDepartment: { key: string; count: number }[];
  bySensitivity: { key: string; count: number }[];
  byDay: { key: string; count: number }[];
  sample: FactRow[];
  scopes?: Array<Record<string, unknown>>;
};
