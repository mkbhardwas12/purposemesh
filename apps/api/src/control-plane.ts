import { DatabaseSync } from "node:sqlite";
import {
  CcaStore,
  MAX_JIT_TTL_MS,
  MIN_JIT_TTL_MS,
  seedStore,
  sha256,
  validateRoleDraft,
  type AppliedRole,
  type RoleDraft,
} from "@cca/core";
import {
  assertExistingSqliteFile,
  prepareWritableSqlitePath,
  restrictNewSqliteFiles,
} from "./sqlite-files.js";

export const ROLE_REQUEST_REQUIRED_APPROVALS = ["data-owner", "governance-admin"] as const;

export type GovernanceReviewerRole = (typeof ROLE_REQUEST_REQUIRED_APPROVALS)[number];

export type RoleRequestApproval = {
  reviewerId: string;
  reviewerRole: GovernanceReviewerRole;
  decision: "approved" | "denied";
  decidedAt: number;
  reason?: string;
};

export type RoleRequest = {
  id: string;
  requesterId: string;
  principalId: string;
  status: "pending" | "approved" | "denied";
  draft: RoleDraft;
  createdAt: number;
  approvalPolicyVersion: 1 | 2;
  requiredApprovals: GovernanceReviewerRole[];
  approvals: RoleRequestApproval[];
  reviewedAt?: number;
  reviewerId?: string;
  reason?: string;
  applied?: AppliedRole;
};

export type JitRequestMetadata = {
  jitId: string;
  justification: string;
  requestedTtlMs: number;
};

export type RecertificationItemStatus = "pending" | "attested" | "revoked" | "removed";
export type RecertificationCampaignStatus = "active" | "completed" | "expired";

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
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
  reviewerRole?: GovernanceReviewerRole | "system";
  reason?: string;
  evidence?: RecertificationEvidence;
};

export type RecertificationCampaign = {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  dueAt: number;
  cadenceDays: number;
  nextCampaignAt: number;
  status: RecertificationCampaignStatus;
  previousCampaignId?: string;
  items: RecertificationItem[];
};

export type ApiControlState = {
  version: 2;
  roleRequests: RoleRequest[];
  jitMetadata: JitRequestMetadata[];
  recertifications: RecertificationCampaign[];
};

export function createApiControlState(): ApiControlState {
  return { version: 2, roleRequests: [], jitMetadata: [], recertifications: [] };
}

export interface ControlPlanePersistence {
  save(store: CcaStore, state: ApiControlState): void;
  check(): void;
  close(): void;
}

type PersistedEnvelope = {
  version: 1;
  store: ReturnType<CcaStore["snapshot"]>;
  api: ApiControlState;
};

export class SqliteControlPlaneRepository implements ControlPlanePersistence {
  private readonly db: DatabaseSync;
  private readonly path: string;
  private readonly created: boolean;

  constructor(path: string, options: { requireExisting?: boolean } = {}) {
    this.path = path;
    if (options.requireExisting) {
      assertExistingSqliteFile(path);
      this.created = false;
    } else {
      this.created = prepareWritableSqlitePath(path).created;
    }
    const db = new DatabaseSync(path);
    try {
      if (options.requireExisting) {
        assertExistingControlPlaneSnapshot(db);
      }
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec(`
        CREATE TABLE IF NOT EXISTS control_plane_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          payload TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS control_plane_readiness (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          checked_at INTEGER NOT NULL
        )
      `);
      restrictNewSqliteFiles(path, this.created);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
  }

  load(mode: "demo" | "test" | "production" = "production"): { store: CcaStore; state: ApiControlState } | undefined {
    const row = this.db
      .prepare("SELECT payload FROM control_plane_state WHERE id = 1")
      .get() as { payload: string } | undefined;
    if (!row) return undefined;
    const migration = migrateLegacyEnvelope(JSON.parse(row.payload) as unknown, mode);
    const apiMigratedFromV1 = hasApiStateVersion(migration.value, 1);
    const parsed = parseEnvelope(migration.value);
    const store = CcaStore.fromSnapshot(parsed.store);
    const result = {
      store,
      state: structuredClone(parsed.api),
    };
    if (migration.migratedFrom === 2) {
      store.appendAudit("system", "store.migrate.v2-v3", {
        fromVersion: 2,
        toVersion: 3,
        strategy: "empty-jit-membership-persona-backfill",
      }, nextMigrationAuditTime(store));
    }
    if (apiMigratedFromV1) {
      store.appendAudit("system", "api-state.migrate.v1-v2", {
        fromVersion: 1,
        toVersion: 2,
        strategy: "dual-approval-and-empty-recertification-state",
      }, nextMigrationAuditTime(store));
    }
    if (migration.migratedFrom === 2 || apiMigratedFromV1) this.save(store, result.state);
    return result;
  }

  save(store: CcaStore, state: ApiControlState): void {
    const envelope: PersistedEnvelope = {
      version: 1,
      store: store.snapshot(),
      api: structuredClone(state),
    };
    const payload = JSON.stringify(envelope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          INSERT INTO control_plane_state(id, payload, updated_at)
          VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
        `)
        .run(payload, Date.now());
      restrictNewSqliteFiles(this.path, this.created);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  check(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          INSERT INTO control_plane_readiness(id, checked_at)
          VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET checked_at = excluded.checked_at
        `)
        .run(Date.now());
      restrictNewSqliteFiles(this.path, this.created);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

function nextMigrationAuditTime(store: CcaStore): number {
  const previous = store.audit.at(-1)?.at ?? 0;
  return previous < Number.MAX_SAFE_INTEGER ? previous + 1 : previous;
}

export function loadOrInitializeControlPlane(
  repository: SqliteControlPlaneRepository,
  mode: "demo" | "test" | "production",
): { store: CcaStore; state: ApiControlState } {
  const persisted = repository.load(mode);
  if (persisted) {
    if (mode === "demo") {
      const changes = reconcileDemoSeed(persisted.store);
      if (changes.length > 0) {
        persisted.store.appendAudit("system", "store.reconcile.demo-seed", {
          changes,
          strategy: "managed-warehouse-seed-refresh",
        });
        // Validate the complete relationship graph before replacing the durable snapshot.
        CcaStore.fromSnapshot(persisted.store.snapshot());
        repository.save(persisted.store, persisted.state);
      }
    }
    return persisted;
  }
  if (mode === "production") {
    throw new Error("production requires an existing, validated control-plane snapshot");
  }
  const store = seedStore();
  const state = createApiControlState();
  repository.save(store, state);
  return { store, state };
}

const MANAGED_WAREHOUSE_CONTRACT_IDS = [
  "wh.l1",
  "wh.l2bw",
  "wh.l2bobj",
  "wh.obs",
  "wh.acme",
  "wh.globex",
  "wh.data-owner",
] as const;

/**
 * Reconciles only built-in demo fixtures that are required by the current warehouse
 * experience. User-created roles and every runtime workflow collection remain intact.
 */
function reconcileDemoSeed(store: CcaStore): string[] {
  const canonical = seedStore();
  const changes: string[] = [];

  const addMissing = <T>(
    target: Map<string, T>,
    source: Map<string, T>,
    id: string,
    kind: string,
  ): void => {
    if (target.has(id)) return;
    const value = source.get(id);
    if (!value) throw new Error(`canonical demo seed is missing ${kind} ${id}`);
    target.set(id, structuredClone(value));
    changes.push(`add:${kind}:${id}`);
  };

  addMissing(store.personas, canonical.personas, "data-owner", "persona");
  addMissing(store.capsules, canonical.capsules, "data-governance-owner", "capsule");
  addMissing(store.principals, canonical.principals, "dana.owner", "principal");
  addMissing(store.principals, canonical.principals, "iris.admin", "principal");

  const canonicalMembership = canonical.memberships.find((membership) =>
    membership.principalId === "dana.owner"
    && membership.capsuleId === "data-governance-owner"
  );
  if (!canonicalMembership) throw new Error("canonical demo seed is missing the data-owner membership");
  if (!store.memberships.some((membership) =>
    membership.principalId === canonicalMembership.principalId
    && membership.capsuleId === canonicalMembership.capsuleId
  )) {
    store.memberships.push(structuredClone(canonicalMembership));
    changes.push("add:membership:dana.owner:data-governance-owner");
  }

  const canonicalSecondAdmin = canonical.memberships.find((membership) =>
    membership.principalId === "iris.admin" && membership.capsuleId === "control-plane"
  );
  if (!canonicalSecondAdmin) throw new Error("canonical demo seed is missing the second administrator membership");
  if (!store.memberships.some((membership) =>
    membership.principalId === canonicalSecondAdmin.principalId
    && membership.capsuleId === canonicalSecondAdmin.capsuleId
  )) {
    store.memberships.push(structuredClone(canonicalSecondAdmin));
    changes.push("add:membership:iris.admin:control-plane");
  }

  const canonicalDataset = canonical.datasets.get("warehouse");
  if (!canonicalDataset) throw new Error("canonical demo seed is missing dataset warehouse");
  if (!sameJson(store.datasets.get("warehouse"), canonicalDataset)) {
    store.datasets.set("warehouse", structuredClone(canonicalDataset));
    changes.push("refresh:dataset:warehouse");
  }

  for (const contractId of MANAGED_WAREHOUSE_CONTRACT_IDS) {
    const canonicalContract = canonical.contracts.get(contractId);
    if (!canonicalContract) throw new Error(`canonical demo seed is missing contract ${contractId}`);
    if (!sameJson(store.contracts.get(contractId), canonicalContract)) {
      store.contracts.set(contractId, structuredClone(canonicalContract));
      changes.push(`refresh:contract:${contractId}`);
    }
  }

  const canonicalBinding = canonical.bindings.find((binding) => binding.contractId === "wh.data-owner");
  if (!canonicalBinding) throw new Error("canonical demo seed is missing the data-owner binding");
  if (!store.bindings.some((binding) =>
    binding.capsuleId === canonicalBinding.capsuleId
    && binding.contractId === canonicalBinding.contractId
  )) {
    let bindingId = canonicalBinding.id;
    if (store.bindings.some((binding) => binding.id === bindingId)) {
      bindingId = "bind-data-governance-owner-wh.data-owner";
    }
    if (store.bindings.some((binding) => binding.id === bindingId)) {
      throw new Error("cannot allocate the canonical data-owner binding without replacing user state");
    }
    store.bindings.push({ ...structuredClone(canonicalBinding), id: bindingId });
    changes.push(`add:binding:${bindingId}`);
  }

  return changes;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertExistingControlPlaneSnapshot(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'control_plane_state'")
    .get() as { name: string } | undefined;
  if (!table) throw new Error("production control-plane database is missing the state table");
  const requiredColumns = new Set(["id", "payload", "updated_at"]);
  const columns = db.prepare("PRAGMA table_info(control_plane_state)").all() as Array<{ name: string }>;
  for (const column of columns) requiredColumns.delete(column.name);
  if (requiredColumns.size > 0) {
    throw new Error(`production control-plane state is missing required columns: ${[...requiredColumns].join(", ")}`);
  }
  const row = db
    .prepare("SELECT payload FROM control_plane_state WHERE id = 1")
    .get() as { payload: string } | undefined;
  if (!row) throw new Error("production requires an existing control-plane snapshot");
  const migrated = migrateLegacyEnvelope(JSON.parse(row.payload) as unknown, "production");
  parseEnvelope(migrated.value);
}

function migrateLegacyEnvelope(
  value: unknown,
  mode: "demo" | "test" | "production",
): { value: unknown; migratedFrom?: 2 } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  const envelope = value as Record<string, unknown>;
  if (!envelope.store || typeof envelope.store !== "object" || Array.isArray(envelope.store)) {
    return { value };
  }
  const legacyStore = envelope.store as Record<string, unknown>;
  if (legacyStore.version !== 2) return { value };
  if (mode === "production") {
    throw new Error("production rejects store snapshot v2; perform a reviewed offline migration to v3");
  }
  if (!Array.isArray(legacyStore.jit) || legacyStore.jit.length > 0) {
    throw new Error("automatic v2 migration refused: legacy JIT grants require reviewed migration");
  }
  if (!Array.isArray(legacyStore.principals) || !Array.isArray(legacyStore.memberships)) {
    throw new Error("automatic v2 migration refused: invalid principal or membership data");
  }
  const principalPersonas = new Map<string, string>();
  for (const item of legacyStore.principals) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("automatic v2 migration refused: invalid principal data");
    }
    const principal = item as Record<string, unknown>;
    if (typeof principal.id !== "string" || typeof principal.personaId !== "string") {
      throw new Error("automatic v2 migration refused: principal identity is incomplete");
    }
    principalPersonas.set(principal.id, principal.personaId);
  }
  const memberships = legacyStore.memberships.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("automatic v2 migration refused: invalid membership data");
    }
    const membership = item as Record<string, unknown>;
    if (typeof membership.principalId !== "string" || typeof membership.capsuleId !== "string") {
      throw new Error("automatic v2 migration refused: membership identity is incomplete");
    }
    const personaId = membership.personaId ?? principalPersonas.get(membership.principalId);
    if (typeof personaId !== "string") {
      throw new Error("automatic v2 migration refused: membership persona cannot be resolved");
    }
    return { ...membership, personaId };
  });
  return {
    value: {
      ...envelope,
      store: {
        ...legacyStore,
        version: 3,
        memberships,
      },
    },
    migratedFrom: 2,
  };
}

function hasApiStateVersion(value: unknown, version: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const api = (value as Record<string, unknown>).api;
  return Boolean(api && typeof api === "object" && !Array.isArray(api)
    && (api as Record<string, unknown>).version === version);
}

function parseEnvelope(value: unknown): PersistedEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid control-plane snapshot");
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.version !== 1) throw new Error("unsupported control-plane snapshot version");
  const store = CcaStore.fromSnapshot(envelope.store);
  const api = parseApiState(envelope.api);
  assertApiRelationships(store, api);
  return {
    version: 1,
    store: envelope.store as PersistedEnvelope["store"],
    api,
  };
}

function parseApiState(value: unknown): ApiControlState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid API control state");
  }
  const input = value as Record<string, unknown>;
  const state = input.version === 1 ? migrateApiStateV1(input) : input;
  if (
    state.version !== 2
    || !Array.isArray(state.roleRequests)
    || !Array.isArray(state.jitMetadata)
    || !Array.isArray(state.recertifications)
  ) {
    throw new Error("invalid API control state");
  }
  for (const request of state.roleRequests) assertRoleRequest(request);
  for (const metadata of state.jitMetadata) assertJitMetadata(metadata);
  for (const campaign of state.recertifications) assertRecertificationCampaign(campaign);
  assertUnique(state.roleRequests.map((request) => (request as RoleRequest).id), "role request id");
  assertUnique(state.jitMetadata.map((metadata) => (metadata as JitRequestMetadata).jitId), "JIT metadata id");
  assertUnique(
    state.recertifications.map((campaign) => (campaign as RecertificationCampaign).id),
    "recertification campaign id",
  );
  return structuredClone(state) as ApiControlState;
}

function migrateApiStateV1(state: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(state.roleRequests) || !Array.isArray(state.jitMetadata)) {
    throw new Error("invalid API control state");
  }
  const roleRequests = state.roleRequests.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid role request snapshot");
    }
    const request = value as Record<string, unknown>;
    if (request.status === "pending") {
      return {
        ...request,
        approvalPolicyVersion: 2,
        requiredApprovals: [...ROLE_REQUEST_REQUIRED_APPROVALS],
        approvals: [],
      };
    }
    const reviewerId = request.reviewerId;
    const reviewedAt = request.reviewedAt;
    const decision = request.status === "approved" ? "approved" : "denied";
    return {
      ...request,
      approvalPolicyVersion: 1,
      requiredApprovals: ["governance-admin"],
      approvals: typeof reviewerId === "string" && Number.isSafeInteger(reviewedAt)
        ? [{
            reviewerId,
            reviewerRole: "governance-admin",
            decision,
            decidedAt: reviewedAt,
            ...(typeof request.reason === "string" ? { reason: request.reason } : {}),
          }]
        : [],
    };
  });
  return {
    version: 2,
    roleRequests,
    jitMetadata: state.jitMetadata,
    recertifications: [],
  };
}

function assertRoleRequest(value: unknown): asserts value is RoleRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid role request snapshot");
  }
  const request = value as Record<string, unknown>;
  if (
    typeof request.id !== "string"
    || typeof request.requesterId !== "string"
    || typeof request.principalId !== "string"
    || !["pending", "approved", "denied"].includes(String(request.status))
    || !Number.isSafeInteger(request.createdAt)
    || ![1, 2].includes(Number(request.approvalPolicyVersion))
    || !Array.isArray(request.requiredApprovals)
    || !Array.isArray(request.approvals)
  ) {
    throw new Error("invalid role request snapshot");
  }
  assertRoleDraft(request.draft);
  const requiredApprovals = request.requiredApprovals as unknown[];
  if (
    requiredApprovals.length === 0
    || requiredApprovals.some((role) => !ROLE_REQUEST_REQUIRED_APPROVALS.includes(role as GovernanceReviewerRole))
    || new Set(requiredApprovals).size !== requiredApprovals.length
  ) {
    throw new Error("invalid role request approval policy");
  }
  const approvals = request.approvals as unknown[];
  approvals.forEach(assertRoleRequestApproval);
  const typedApprovals = approvals as RoleRequestApproval[];
  if (new Set(typedApprovals.map((approval) => approval.reviewerRole)).size !== typedApprovals.length) {
    throw new Error("duplicate role request reviewer role");
  }
  if (new Set(typedApprovals.map((approval) => approval.reviewerId)).size !== typedApprovals.length) {
    throw new Error("duplicate role request reviewer identity");
  }
  if (typedApprovals.some((approval) =>
    approval.reviewerId === request.requesterId
    || approval.reviewerId === request.principalId
    || !requiredApprovals.includes(approval.reviewerRole)
    || approval.decidedAt < Number(request.createdAt)
  )) {
    throw new Error("role request approval violates independent-review policy");
  }
  if (request.reviewedAt !== undefined && !Number.isSafeInteger(request.reviewedAt)) {
    throw new Error("invalid role request review time");
  }
  if (Number.isSafeInteger(request.reviewedAt) && Number(request.reviewedAt) < Number(request.createdAt)) {
    throw new Error("role request review cannot predate creation");
  }
  if (request.reviewerId !== undefined && typeof request.reviewerId !== "string") {
    throw new Error("invalid role request reviewer");
  }
  if (request.reason !== undefined && typeof request.reason !== "string") {
    throw new Error("invalid role request reason");
  }
  if (request.status === "pending" && (
    request.reviewedAt !== undefined
    || request.reviewerId !== undefined
    || request.applied !== undefined
    || typedApprovals.some((approval) => approval.decision !== "approved")
  )) {
    throw new Error("pending role request cannot be reviewed");
  }
  if (request.status !== "pending" && (!Number.isSafeInteger(request.reviewedAt) || typeof request.reviewerId !== "string")) {
    throw new Error("decided role request must include review metadata");
  }
  if (request.status === "approved" && (!request.applied || typeof request.applied !== "object")) {
    throw new Error("approved role request must include applied role metadata");
  }
  if (
    request.status === "approved"
    && requiredApprovals.some((role) => !typedApprovals.some((approval) =>
      approval.reviewerRole === role && approval.decision === "approved"
    ))
  ) {
    throw new Error("approved role request is missing a required approval");
  }
  if (request.status === "denied" && !typedApprovals.some((approval) => approval.decision === "denied")) {
    throw new Error("denied role request is missing denial evidence");
  }
}

function assertRoleRequestApproval(value: unknown): asserts value is RoleRequestApproval {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid role request approval");
  }
  const approval = value as Record<string, unknown>;
  if (
    typeof approval.reviewerId !== "string"
    || !ROLE_REQUEST_REQUIRED_APPROVALS.includes(approval.reviewerRole as GovernanceReviewerRole)
    || !["approved", "denied"].includes(String(approval.decision))
    || !Number.isSafeInteger(approval.decidedAt)
    || (approval.reason !== undefined && typeof approval.reason !== "string")
  ) {
    throw new Error("invalid role request approval");
  }
}

function assertJitMetadata(value: unknown): asserts value is JitRequestMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid JIT metadata snapshot");
  }
  const metadata = value as Record<string, unknown>;
  if (
    typeof metadata.jitId !== "string"
    || typeof metadata.justification !== "string"
    || !Number.isSafeInteger(metadata.requestedTtlMs)
    || Number(metadata.requestedTtlMs) < MIN_JIT_TTL_MS
    || Number(metadata.requestedTtlMs) > MAX_JIT_TTL_MS
  ) {
    throw new Error("invalid JIT metadata snapshot");
  }
}

function assertRecertificationCampaign(value: unknown): asserts value is RecertificationCampaign {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid recertification campaign snapshot");
  }
  const campaign = value as Record<string, unknown>;
  if (
    typeof campaign.id !== "string"
    || typeof campaign.name !== "string"
    || !campaign.name.trim()
    || typeof campaign.createdBy !== "string"
    || !Number.isSafeInteger(campaign.createdAt)
    || !Number.isSafeInteger(campaign.dueAt)
    || Number(campaign.dueAt) <= Number(campaign.createdAt)
    || !Number.isSafeInteger(campaign.cadenceDays)
    || Number(campaign.cadenceDays) < 1
    || Number(campaign.cadenceDays) > 365
    || !Number.isSafeInteger(campaign.nextCampaignAt)
    || Number(campaign.nextCampaignAt) <= Number(campaign.createdAt)
    || !["active", "completed", "expired"].includes(String(campaign.status))
    || !Array.isArray(campaign.items)
    || (campaign.previousCampaignId !== undefined && typeof campaign.previousCampaignId !== "string")
  ) {
    throw new Error("invalid recertification campaign snapshot");
  }
  campaign.items.forEach(assertRecertificationItem);
  assertUnique(
    (campaign.items as RecertificationItem[]).map((item) => item.id),
    `recertification item id in ${campaign.id}`,
  );
  const items = campaign.items as RecertificationItem[];
  const pending = items.some((item) => item.status === "pending");
  if (campaign.status === "completed" && pending) {
    throw new Error("completed recertification campaign has pending items");
  }
  if (campaign.status === "active" && !pending) {
    throw new Error("active recertification campaign has no pending items");
  }
}

function assertRecertificationItem(value: unknown): asserts value is RecertificationItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid recertification item snapshot");
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string"
    || typeof item.principalId !== "string"
    || typeof item.capsuleId !== "string"
    || typeof item.personaId !== "string"
    || typeof item.assignmentId !== "string"
    || !item.assignmentId.trim()
    || !["pending", "attested", "revoked", "removed"].includes(String(item.status))
    || !Array.isArray(item.eligibleReviewerRoles)
    || (item.eligibleReviewerRoles as unknown[]).length === 0
    || (item.eligibleReviewerRoles as unknown[]).some((role) =>
      !ROLE_REQUEST_REQUIRED_APPROVALS.includes(role as GovernanceReviewerRole)
    )
    || new Set(item.eligibleReviewerRoles as unknown[]).size !== (item.eligibleReviewerRoles as unknown[]).length
    || !Number.isSafeInteger(item.createdAt)
  ) {
    throw new Error("invalid recertification item snapshot");
  }
  if (item.status === "pending") {
    if (
      item.decidedAt !== undefined
      || item.decidedBy !== undefined
      || item.reviewerRole !== undefined
      || item.reason !== undefined
      || item.evidence !== undefined
    ) throw new Error("pending recertification item cannot contain decision evidence");
    return;
  }
  if (
    !Number.isSafeInteger(item.decidedAt)
    || typeof item.decidedBy !== "string"
    || ![...ROLE_REQUEST_REQUIRED_APPROVALS, "system"].includes(String(item.reviewerRole))
    || typeof item.reason !== "string"
    || !item.reason.trim()
    || !item.evidence
    || typeof item.evidence !== "object"
    || Array.isArray(item.evidence)
  ) {
    throw new Error("decided recertification item requires decision evidence");
  }
  const evidence = item.evidence as Record<string, unknown>;
  if (
    !Number.isSafeInteger(evidence.auditSeq)
    || typeof evidence.auditHash !== "string"
    || !/^[a-f0-9]{64}$/.test(evidence.auditHash)
    || typeof evidence.membershipFingerprint !== "string"
  ) {
    throw new Error("invalid recertification evidence");
  }
  const expectedFingerprint = sha256(JSON.stringify({
    principalId: item.principalId,
    capsuleId: item.capsuleId,
    personaId: item.personaId,
    assignmentId: item.assignmentId,
  }));
  if (evidence.membershipFingerprint !== expectedFingerprint) {
    throw new Error("recertification membership fingerprint mismatch");
  }
}

function assertRoleDraft(value: unknown): asserts value is RoleDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid role request draft");
  }
  const draft = value as Record<string, unknown>;
  const arrays = ["verbs", "products", "tenants", "regions", "departments", "denyFields", "sources"];
  if (
    typeof draft.name !== "string"
    || typeof draft.purpose !== "string"
    || !["internal", "confidential", "restricted"].includes(String(draft.ceiling))
    || arrays.some((key) => !Array.isArray(draft[key]) || (draft[key] as unknown[]).some((item) => typeof item !== "string"))
  ) {
    throw new Error("invalid role request draft");
  }
  const errors = validateRoleDraft(draft as RoleDraft);
  if (errors.length > 0) throw new Error(`invalid role request draft: ${errors.join("; ")}`);
}

function assertApiRelationships(store: CcaStore, state: ApiControlState): void {
  const jitIds = new Set(store.jit.map((grant) => grant.id));
  for (const metadata of state.jitMetadata) {
    if (!jitIds.has(metadata.jitId)) throw new Error("JIT metadata references an unknown grant");
  }
  for (const request of state.roleRequests) {
    if (!store.principals.has(request.requesterId) || !store.principals.has(request.principalId)) {
      throw new Error("role request references an unknown principal");
    }
    if (request.reviewerId && !store.principals.has(request.reviewerId)) {
      throw new Error("role request references an unknown reviewer");
    }
    for (const approval of request.approvals) {
      if (!store.principals.has(approval.reviewerId)) {
        throw new Error("role request approval references an unknown reviewer");
      }
    }
    if (request.applied && (
      !store.personas.has(request.applied.personaId)
      || !store.capsules.has(request.applied.capsuleId)
      || !store.contracts.has(request.applied.contractId)
    )) {
      throw new Error("role request references unknown applied state");
    }
  }
  const campaignIds = new Set(state.recertifications.map((campaign) => campaign.id));
  for (const campaign of state.recertifications) {
    if (!store.principals.has(campaign.createdBy)) {
      throw new Error("recertification campaign references an unknown creator");
    }
    if (campaign.previousCampaignId && !campaignIds.has(campaign.previousCampaignId)) {
      throw new Error("recertification campaign references an unknown previous campaign");
    }
    for (const item of campaign.items) {
      if (
        !store.principals.has(item.principalId)
        || !store.capsules.has(item.capsuleId)
        || !store.personas.has(item.personaId)
        || (item.decidedBy !== undefined && item.decidedBy !== "system" && !store.principals.has(item.decidedBy))
      ) {
        throw new Error("recertification item references unknown access state");
      }
      if (item.evidence) {
        const event = store.audit[item.evidence.auditSeq - 1];
        if (
          !event
          || event.hash !== item.evidence.auditHash
          || event.detail.campaignId !== campaign.id
          || event.detail.itemId !== item.id
          || ![
            "recertification.item.attest",
            "recertification.item.revoke",
            "recertification.item.removed",
          ].includes(event.type)
        ) {
          throw new Error("recertification evidence does not match the audit chain");
        }
      }
    }
  }
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
}
