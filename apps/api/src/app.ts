import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import {
  CLASS_RANK,
  DEFAULT_JIT_TTL_MS,
  DEMO_USERS,
  MAX_JIT_TTL_MS,
  MIN_JIT_TTL_MS,
  ROLE_PALETTE,
  WAREHOUSE_ALLOWED_FIELDS,
  addMembership,
  applyRoleDraft,
  approveJit,
  check,
  compileAll,
  compileCapsule,
  denyJit,
  evaluatePrincipalSod,
  evaluateRoleDraftSod,
  explainAccess,
  filterDataset,
  isControlPlaneAdmin,
  governanceReviewerRoleFor,
  intersectFieldPaths,
  membershipAssignmentId,
  offboardCapsule,
  parseNeedToRole,
  removeMembership,
  recertificationReviewerRolesFor,
  requestJit,
  revokeMembershipForRecertification,
  revokeJit,
  scopeFromDraft,
  seedStore,
  validateRoleDraft,
  verifyPassword,
  WAREHOUSE_SOD_RULES,
  warehouseScopesFor,
  sha256,
  type Action,
  type CcaStore,
  type Classification,
  type DataScope,
  type RoleDraft,
} from "@cca/core";
import {
  ROLE_REQUEST_REQUIRED_APPROVALS,
  createApiControlState,
  type ApiControlState,
  type ControlPlanePersistence,
  type GovernanceReviewerRole,
  type RecertificationCampaign,
  type RecertificationItem,
  type RoleRequest,
} from "./control-plane.js";
import { readRuntimeMode, signAccessToken, verifyAccessToken, type AccessToken } from "./jwt.js";
import {
  askBodySchema,
  authzenEvaluationBodySchema,
  idParamsSchema,
  jitApproveBodySchema,
  jitRequestBodySchema,
  jitRevokeBodySchema,
  loginBodySchema,
  membershipBodySchema,
  membershipParamsSchema,
  offboardBodySchema,
  paginationQuerySchema,
  pdpCheckBodySchema,
  purposeQuerySchema,
  recertificationCreateBodySchema,
  recertificationDecisionBodySchema,
  recertificationItemParamsSchema,
  recertificationItemsQuerySchema,
  recertificationListQuerySchema,
  roleApplyBodySchema,
  roleDraftBodySchema,
  roleRequestBodySchema,
  roleRequestDecisionBodySchema,
  sodViolationsQuerySchema,
  warehousePageQuerySchema,
} from "./schemas.js";
import { openWarehouse, scopesToFilter, type Warehouse } from "./warehouse.js";

type LoginRateLimit = {
  maxAttempts: number;
  windowMs: number;
  blockMs: number;
  maxTrackedKeys: number;
};

export type BuildAppOptions = {
  warehouse?: Warehouse;
  state?: ApiControlState;
  persistence?: ControlPlanePersistence;
  ownWarehouse?: boolean;
  ownPersistence?: boolean;
  demoMode?: boolean;
  logger?: boolean;
  logLevel?: string;
  corsOrigins?: string[];
  trustProxy?: boolean;
  loginRateLimit?: Partial<LoginRateLimit>;
};

class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const DEFAULT_CORS_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];
const DEFAULT_LOGIN_LIMIT: LoginRateLimit = {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
  maxTrackedKeys: 10_000,
};

function fail(statusCode: number, code: string, message: string): never {
  throw new ApiError(statusCode, code, message);
}

function failWithDetails(statusCode: number, code: string, message: string, details: unknown): never {
  throw new ApiError(statusCode, code, message, details);
}

function authzenDeny(reason: string) {
  return {
    decision: false,
    context: {
      reason,
      obligations: { allowedFields: [], denyFields: [], contractIds: [], capsuleIds: [] },
    },
  };
}

function domainCall<T>(
  operation: () => T,
  opaque?: { code: string; message: string },
): T {
  try {
    return operation();
  } catch (error) {
    if (opaque) fail(400, opaque.code, opaque.message);
    fail(400, "invalid_request", error instanceof Error ? error.message : "invalid request");
  }
}

function publicPrincipal(store: CcaStore, id: string) {
  const principal = store.principals.get(id);
  if (!principal) return null;
  const persona = store.personas.get(principal.personaId);
  const capsules = store.liveCapsulesFor(id).map((capsule) => ({
    id: capsule.id,
    label: capsule.label,
    purpose: capsule.purpose,
  }));
  const assignments = store.liveMembershipsFor(id).map(({ capsule, persona: assignedPersona }) => ({
    capsuleId: capsule.id,
    capsuleLabel: capsule.label,
    purpose: capsule.purpose,
    personaId: assignedPersona.id,
    personaLabel: assignedPersona.label,
    inherits: assignedPersona.inherits,
    actions: assignedPersona.actions,
    ceiling: assignedPersona.ceiling,
  }));
  return {
    id: principal.id,
    username: principal.username,
    displayName: principal.displayName,
    personaId: principal.personaId,
    personaLabel: persona?.label,
    kind: principal.kind,
    disabled: principal.disabled,
    capsules,
    actions: persona?.actions ?? [],
    ceiling: persona?.ceiling,
    inherits: persona?.inherits,
    assignments,
  };
}

async function authenticate(request: FastifyRequest, store: CcaStore): Promise<AccessToken> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) fail(401, "authentication_required", "missing bearer token");
  let actor: AccessToken;
  try {
    actor = await verifyAccessToken(header.slice("Bearer ".length));
  } catch {
    fail(401, "invalid_token", "invalid or expired token");
  }
  const principal = store.principals.get(actor.sub);
  if (!principal || principal.disabled) fail(401, "principal_inactive", "principal is inactive");
  if (principal.personaId !== actor.persona || principal.kind !== actor.kind) {
    fail(401, "session_stale", "access token no longer matches the principal");
  }
  const currentCapsules = store.liveCapsulesFor(principal.id).map((capsule) => capsule.id).sort();
  const tokenCapsules = [...new Set(actor.capsules)].sort();
  if (
    currentCapsules.length !== tokenCapsules.length
    || currentCapsules.some((capsuleId, index) => capsuleId !== tokenCapsules[index])
    || actor.authorizationFingerprint !== authorizationFingerprintFor(store, principal.id)
  ) {
    fail(401, "session_stale", "access token no longer matches active scope assignments");
  }
  return actor;
}

function requireAdmin(store: CcaStore, actor: AccessToken): void {
  if (!isControlPlaneAdmin(store, actor.sub)) {
    fail(403, "admin_required", "active control-plane administrator required");
  }
}

function requireTokenPurpose(actor: AccessToken, requestedPurpose: string): void {
  if (actor.purpose !== undefined && actor.purpose !== requestedPurpose) {
    fail(403, "purpose_mismatch", "request purpose does not match the access token");
  }
}

function requireGovernanceAdmin(store: CcaStore, actor: AccessToken): void {
  requireAdmin(store, actor);
  requireTokenPurpose(actor, "governance");
}

function requireGovernanceReviewer(
  store: CcaStore,
  actor: AccessToken,
): GovernanceReviewerRole {
  const reviewerRole = governanceReviewerRoleFor(store, actor.sub);
  if (!reviewerRole) fail(403, "governance_reviewer_required", "active data owner or governance administrator required");
  requireTokenPurpose(actor, reviewerRole === "governance-admin" ? "governance" : "data-governance");
  return reviewerRole;
}

function requireIndependentReviewer(actorId: string, request: RoleRequest): void {
  if (actorId === request.requesterId || actorId === request.principalId) {
    fail(409, "self_approval_forbidden", "requester and target cannot approve or deny their own access");
  }
}

function reviewerHasRole(
  store: CcaStore,
  principalId: string,
  role: GovernanceReviewerRole,
): boolean {
  return role === "governance-admin"
    ? isControlPlaneAdmin(store, principalId)
    : isWarehouseDataOwner(store, principalId);
}

function ensureIndependentRoleReviewers(
  store: CcaStore,
  requesterId: string,
  principalId: string,
): void {
  const candidates = Object.fromEntries(ROLE_REQUEST_REQUIRED_APPROVALS.map((role) => [
    role,
    [...store.principals.values()]
      .filter((principal) =>
        principal.kind === "human"
        && !principal.disabled
        && principal.id !== requesterId
        && principal.id !== principalId
        && reviewerHasRole(store, principal.id, role)
      )
      .map((principal) => principal.id),
  ])) as Record<GovernanceReviewerRole, string[]>;
  const hasDistinctPair = candidates["data-owner"].some((ownerId) =>
    candidates["governance-admin"].some((adminId) => adminId !== ownerId)
  );
  if (hasDistinctPair) return;
  const missingReviewerRoles = ROLE_REQUEST_REQUIRED_APPROVALS.filter((role) => candidates[role].length === 0);
  failWithDetails(
    409,
    "independent_reviewer_unavailable",
    "the request cannot be created until distinct data-owner and governance-admin reviewers are available",
    {
      missingReviewerRoles,
      availableReviewerCounts: Object.fromEntries(
        ROLE_REQUEST_REQUIRED_APPROVALS.map((role) => [role, candidates[role].length]),
      ),
    },
  );
}

function page<T>(values: T[], query: { cursor?: number; limit?: number }) {
  const cursor = query.cursor ?? 0;
  const limit = query.limit ?? 100;
  const items = values.slice(cursor, cursor + limit);
  const nextCursor = cursor + items.length < values.length ? cursor + items.length : undefined;
  return { items, nextCursor, total: values.length };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function membershipFingerprint(item: {
  principalId: string;
  capsuleId: string;
  personaId: string;
  assignmentId: string;
}): string {
  return sha256(JSON.stringify({
    principalId: item.principalId,
    capsuleId: item.capsuleId,
    personaId: item.personaId,
    assignmentId: item.assignmentId,
  }));
}

/**
 * Binds a session to the exact live assignment instances, not only capsule names.
 * Removing and later re-granting the same capsule creates a new assignmentId and
 * therefore cannot make an older token valid again.
 */
export function authorizationFingerprintFor(store: CcaStore, principalId: string): string {
  const assignments = store.liveMembershipsFor(principalId)
    .map(({ membership, capsule, persona }) => membershipFingerprint({
      principalId,
      capsuleId: capsule.id,
      personaId: persona.id,
      assignmentId: membershipAssignmentId(membership),
    }))
    .sort();
  return sha256(JSON.stringify({ version: 1, principalId, assignments }));
}

function createRecertificationCampaign(
  store: CcaStore,
  input: {
    name: string;
    createdBy: string;
    dueAt: number;
    cadenceDays: number;
    now: number;
    previousCampaignId?: string;
  },
): RecertificationCampaign {
  if (!Number.isSafeInteger(input.dueAt) || input.dueAt <= input.now) {
    throw new Error("recertification dueAt must be in the future");
  }
  if (!Number.isSafeInteger(input.cadenceDays) || input.cadenceDays < 1 || input.cadenceDays > 365) {
    throw new Error("recertification cadenceDays must be between 1 and 365");
  }
  const nextCampaignAt = input.now + input.cadenceDays * DAY_MS;
  if (!Number.isSafeInteger(nextCampaignAt)) throw new Error("recertification schedule exceeds supported time range");
  const items: RecertificationItem[] = store.memberships.flatMap((membership) => {
    const principal = store.principals.get(membership.principalId);
    const capsule = store.capsules.get(membership.capsuleId);
    const personaId = membership.personaId ?? principal?.personaId;
    if (!principal || principal.disabled || principal.kind !== "human" || !capsule?.active || !personaId) return [];
    const eligibleReviewerRoles = recertificationReviewerRolesFor(
      store,
      membership.principalId,
      membership.capsuleId,
    );
    if (eligibleReviewerRoles.length === 0) return [];
    return [{
      id: `recert-item-${randomUUID()}`,
      principalId: membership.principalId,
      capsuleId: membership.capsuleId,
      personaId,
      assignmentId: membershipAssignmentId(membership),
      status: "pending" as const,
      eligibleReviewerRoles,
      createdAt: input.now,
    }];
  });
  return {
    id: `recert-${randomUUID()}`,
    name: input.name.trim(),
    createdBy: input.createdBy,
    createdAt: input.now,
    dueAt: input.dueAt,
    cadenceDays: input.cadenceDays,
    nextCampaignAt,
    status: items.length === 0 ? "completed" : "active",
    ...(input.previousCampaignId ? { previousCampaignId: input.previousCampaignId } : {}),
    items,
  };
}

function refreshRecertifications(
  store: CcaStore,
  campaigns: RecertificationCampaign[],
  now = Date.now(),
): void {
  for (const campaign of campaigns) {
    if (campaign.status !== "active") continue;
    for (const item of campaign.items) {
      if (item.status !== "pending") continue;
      const active = store.liveMembershipsFor(item.principalId).some(({ membership, persona }) =>
        membership.capsuleId === item.capsuleId
        && persona.id === item.personaId
        && membershipAssignmentId(membership) === item.assignmentId
      );
      if (active) continue;
      const audit = store.appendAudit("system", "recertification.item.removed", {
        campaignId: campaign.id,
        itemId: item.id,
        principalId: item.principalId,
        capsuleId: item.capsuleId,
        personaId: item.personaId,
        reason: "membership no longer active",
      }, now);
      item.status = "removed";
      item.decidedAt = now;
      item.decidedBy = "system";
      item.reviewerRole = "system";
      item.reason = "membership no longer active";
      item.evidence = {
        auditSeq: audit.seq,
        auditHash: audit.hash,
        membershipFingerprint: membershipFingerprint(item),
      };
    }
    if (!campaign.items.some((item) => item.status === "pending")) {
      campaign.status = "completed";
      store.appendAudit("system", "recertification.campaign.complete", {
        campaignId: campaign.id,
        itemCount: campaign.items.length,
      }, now);
    } else if (campaign.dueAt <= now) {
      campaign.status = "expired";
      store.appendAudit("system", "recertification.campaign.expire", {
        campaignId: campaign.id,
        dueAt: campaign.dueAt,
        pending: campaign.items.filter((item) => item.status === "pending").length,
      }, now);
    }
  }
}

function recertificationCampaignSummary(campaign: RecertificationCampaign) {
  const counts = campaign.items.reduce<Record<RecertificationItem["status"], number>>(
    (result, item) => {
      result[item.status] += 1;
      return result;
    },
    { pending: 0, attested: 0, revoked: 0, removed: 0 },
  );
  return {
    id: campaign.id,
    name: campaign.name,
    createdBy: campaign.createdBy,
    createdAt: campaign.createdAt,
    dueAt: campaign.dueAt,
    cadenceDays: campaign.cadenceDays,
    nextCampaignAt: campaign.nextCampaignAt,
    status: campaign.status,
    expiryEnforcement: "lazy-on-api-access" as const,
    overdueDecisionPolicy: "blocked" as const,
    previousCampaignId: campaign.previousCampaignId,
    itemCount: campaign.items.length,
    counts,
  };
}

export function buildApp(
  store: CcaStore = seedStore(),
  opts: BuildAppOptions = {},
): FastifyInstance {
  const warehouse = opts.warehouse ?? openWarehouse({ path: ":memory:", rows: 2500 });
  const state = opts.state ?? createApiControlState();
  const persistence = opts.persistence;
  const demoMode = opts.demoMode ?? readRuntimeMode() !== "production";
  const corsOrigins = opts.corsOrigins ?? DEFAULT_CORS_ORIGINS;
  const loginLimit = { ...DEFAULT_LOGIN_LIMIT, ...opts.loginRateLimit };
  if (Object.values(loginLimit).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("login rate-limit values must be positive integers");
  }
  const loginAttempts = new Map<string, { count: number; windowStart: number; blockedUntil: number }>();
  const app = Fastify({
    logger: opts.logger
      ? {
          level: opts.logLevel ?? "info",
          redact: ["req.headers.authorization", "req.headers.cookie", "password", "token"],
        }
      : false,
    trustProxy: opts.trustProxy ?? false,
    bodyLimit: 1_048_576,
    requestTimeout: 15_000,
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: true,
        useDefaults: true,
      },
    },
  });

  app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    maxAge: 600,
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
    return payload;
  });

  const mutateAndPersist = <T>(mutation: () => T): T => {
    if (!persistence) return mutation();
    const storeBefore = store.snapshot();
    const stateBefore = structuredClone(state);
    try {
      const result = mutation();
      persistence.save(store, state);
      return result;
    } catch (error) {
      store.restore(storeBefore);
      state.version = stateBefore.version;
      state.roleRequests = stateBefore.roleRequests;
      state.jitMetadata = stateBefore.jitMetadata;
      state.recertifications = stateBefore.recertifications;
      throw error;
    }
  };

  app.setErrorHandler((error, request, reply) => {
    const validation = (error as { validation?: unknown }).validation;
    if (validation) {
      return reply.code(400).send({
        error: "request validation failed",
        code: "validation_error",
        requestId: request.id,
        details: validation,
      });
    }
    const frameworkStatus = (error as { statusCode?: unknown }).statusCode;
    const statusCode = error instanceof ApiError
      ? error.statusCode
      : typeof frameworkStatus === "number" && frameworkStatus >= 400 && frameworkStatus < 500
        ? frameworkStatus
        : 500;
    const code = error instanceof ApiError
      ? error.code
      : statusCode < 500 ? "bad_request" : "internal_error";
    if (statusCode >= 500) request.log.error({ err: error }, "request failed");
    return reply.code(statusCode).send({
      error: statusCode >= 500
        ? "internal server error"
        : error instanceof Error ? error.message : "request failed",
      code,
      requestId: request.id,
      ...(error instanceof ApiError && error.details !== undefined ? { details: error.details } : {}),
    });
  });

  app.get("/api/health", async () => ({ ok: true, name: "cca-control-plane" }));

  app.get("/api/ready", async (_request, reply) => {
    try {
      persistence?.check();
      warehouse.count();
      return { ok: true, persistence: persistence ? "ready" : "memory" };
    } catch (error) {
      app.log.error({ err: error }, "readiness check failed");
      return reply.code(503).send({ ok: false, error: "dependency unavailable" });
    }
  });

  app.get("/api/auth/directory", async (_request, reply) => {
    if (!demoMode) return reply.code(404).send({ error: "not found", code: "not_found" });
    return { password: "cca-demo", users: DEMO_USERS };
  });

  app.post("/api/auth/login", { schema: { body: loginBodySchema } }, async (request, reply) => {
    if (!demoMode) return reply.code(404).send({ error: "not found", code: "not_found" });
    const body = request.body as { username: string; password: string };
    const now = Date.now();
    const key = `${request.ip}\u0000${body.username.toLowerCase()}`;
    for (const [trackedKey, tracked] of loginAttempts) {
      if (tracked.blockedUntil <= now && now - tracked.windowStart >= loginLimit.windowMs) {
        loginAttempts.delete(trackedKey);
      }
    }
    const attempt = loginAttempts.get(key);
    if (attempt?.blockedUntil && attempt.blockedUntil > now) {
      reply.header("retry-after", Math.ceil((attempt.blockedUntil - now) / 1000));
      return reply.code(429).send({ error: "too many login attempts", code: "rate_limited" });
    }
    if (attempt && now - attempt.windowStart >= loginLimit.windowMs) loginAttempts.delete(key);

    const principal = store.principals.get(body.username);
    if (!principal || principal.disabled || !verifyPassword(body.password, principal.passwordHash)) {
      const current = loginAttempts.get(key);
      const next = current ?? { count: 0, windowStart: now, blockedUntil: 0 };
      if (!current) {
        while (loginAttempts.size >= loginLimit.maxTrackedKeys) {
          const oldestKey = loginAttempts.keys().next().value as string | undefined;
          if (oldestKey === undefined) break;
          loginAttempts.delete(oldestKey);
        }
      }
      next.count += 1;
      if (next.count >= loginLimit.maxAttempts) next.blockedUntil = now + loginLimit.blockMs;
      loginAttempts.set(key, next);
      mutateAndPersist(() => {
        store.appendAudit(principal?.id ?? "anonymous", "auth.login.failed", { username: body.username });
      });
      return reply.code(401).send({ error: "invalid credentials", code: "invalid_credentials" });
    }

    loginAttempts.delete(key);
    const capsules = store.liveCapsulesFor(principal.id);
    const token = await signAccessToken({
      sub: principal.id,
      persona: principal.personaId,
      capsules: capsules.map((capsule) => capsule.id),
      authorizationFingerprint: authorizationFingerprintFor(store, principal.id),
      kind: principal.kind,
    });
    mutateAndPersist(() => {
      store.appendAudit(principal.id, "auth.login", { capsules: capsules.map((capsule) => capsule.id) });
    });
    return { token, principal: publicPrincipal(store, principal.id) };
  });

  app.get("/api/auth/me", async (request) => {
    const actor = await authenticate(request, store);
    return publicPrincipal(store, actor.sub);
  });

  app.get("/api/catalog", async (request) => {
    const actor = await authenticate(request, store);
    if (isControlPlaneAdmin(store, actor.sub)) {
      requireGovernanceAdmin(store, actor);
      return { ...fullCatalog(store), features: { demoReset: demoMode } };
    }
    return { ...scopedCatalog(store, actor.sub, actor.purpose), features: { demoReset: false } };
  });

  app.get("/api/pdp/explain", async (request) => {
    const actor = await authenticate(request, store);
    return { surfaces: explainAccess(store, actor.sub, undefined, actor.purpose) };
  });

  app.post("/api/pdp/check", { schema: { body: pdpCheckBodySchema } }, async (request) => {
    const actor = await authenticate(request, store);
    const body = request.body as {
      action: Action;
      datasetId: string;
      recordId?: string;
      purpose: string;
      principalId?: string;
    };
    requireTokenPurpose(actor, body.purpose);
    if (body.principalId && body.principalId !== actor.sub) requireGovernanceAdmin(store, actor);
    const principalId = body.principalId ?? actor.sub;
    const record = body.recordId ? store.records.find((item) => item.id === body.recordId) : undefined;
    if (body.recordId && !record) fail(404, "record_not_found", "record not found");
    const decision = check(store, { principalId, action: body.action, datasetId: body.datasetId, record, purpose: body.purpose });
    mutateAndPersist(() => {
      store.appendAudit(actor.sub, "pdp.check", {
        principalId,
        datasetId: body.datasetId,
        action: body.action,
        purpose: body.purpose,
        effect: decision.effect,
        reason: decision.reason,
      });
    });
    return decision;
  });

  app.post(
    "/access/v1/evaluation",
    { schema: { body: authzenEvaluationBodySchema } },
    async (request) => {
      const actor = await authenticate(request, store);
      const body = request.body as {
        subject: { id: string; type?: "user" | "workload" };
        action: { name: Action };
        resource: { id: string; type?: "dataset" };
        context: { purpose: string; recordId?: string };
      };
      if (body.subject.id !== actor.sub) requireGovernanceAdmin(store, actor);
      else requireTokenPurpose(actor, body.context.purpose);

      const denyEvaluation = (reason: string) => {
        mutateAndPersist(() => {
          store.appendAudit(actor.sub, "authzen.evaluation", {
            subjectId: body.subject.id,
            action: body.action.name,
            resourceId: body.resource.id,
            recordId: body.context.recordId ?? null,
            purpose: body.context.purpose,
            effect: "deny",
            reason,
          });
        });
        return authzenDeny(reason);
      };

      const target = store.principals.get(body.subject.id);
      const assertedKind = body.subject.type === "user" ? "human" : body.subject.type;
      if (assertedKind !== undefined && target?.kind !== assertedKind) {
        return denyEvaluation("subject_type_mismatch");
      }
      const dataset = store.datasets.get(body.resource.id);
      if (!dataset || dataset.controlPlane || body.resource.type && body.resource.type !== "dataset") {
        return denyEvaluation("resource_unknown");
      }
      const record = body.context.recordId === undefined
        ? undefined
        : store.records.find((item) =>
          item.id === body.context.recordId && item.datasetId === dataset.id
        );
      if (body.context.recordId !== undefined && !record) return denyEvaluation("record_unknown");

      const decision = check(store, {
        principalId: body.subject.id,
        action: body.action.name,
        datasetId: dataset.id,
        record,
        purpose: body.context.purpose,
      });
      mutateAndPersist(() => {
        store.appendAudit(actor.sub, "authzen.evaluation", {
          subjectId: body.subject.id,
          action: body.action.name,
          resourceId: dataset.id,
          recordId: body.context.recordId ?? null,
          purpose: body.context.purpose,
          effect: decision.effect,
          reason: decision.reason,
        });
      });
      const policyVersion = decision.jitId
        ? store.jit.find((grant) => grant.id === decision.jitId)?.policyVersion
        : undefined;
      return {
        decision: decision.effect === "allow",
        context: {
          reason: decision.reason,
          obligations: {
            allowedFields: decision.allowedFields,
            denyFields: decision.denyFields,
            contractIds: decision.contractIds ?? (decision.contractId ? [decision.contractId] : []),
            capsuleIds: decision.capsuleIds ?? (decision.capsuleId ? [decision.capsuleId] : []),
            ...(policyVersion ? { policyVersion } : {}),
          },
        },
      };
    },
  );

  app.get(
    "/api/data/:datasetId",
    { schema: { params: idParamsSchema("datasetId"), querystring: purposeQuerySchema } },
    async (request, reply) => {
      const actor = await authenticate(request, store);
      const { datasetId } = request.params as { datasetId: string };
      const { purpose } = request.query as { purpose: string };
      requireTokenPurpose(actor, purpose);
      const dataset = store.datasets.get(datasetId);
      if (!dataset || dataset.controlPlane) return reply.code(404).send({ error: "unknown dataset", code: "not_found" });
      const result = filterDataset(store, actor.sub, datasetId, purpose);
      mutateAndPersist(() => {
        store.appendAudit(actor.sub, "data.read", {
          datasetId,
          purpose,
          effect: result.decision.effect,
          rows: result.records.length,
        });
      });
      return result;
    },
  );

  app.get("/api/compiler", async (request) => {
    const actor = await authenticate(request, store);
    requireGovernanceAdmin(store, actor);
    return { policies: compileAll(store) };
  });

  app.get(
    "/api/compiler/:capsuleId",
    { schema: { params: idParamsSchema("capsuleId") } },
    async (request) => {
      const actor = await authenticate(request, store);
      requireGovernanceAdmin(store, actor);
      const { capsuleId } = request.params as { capsuleId: string };
      const capsule = store.capsules.get(capsuleId);
      if (!capsule) fail(404, "capsule_not_found", "capsule not found");
      if (!capsule.active) fail(409, "capsule_inactive", "capsule is inactive");
      return compileCapsule(store, capsuleId);
    },
  );

  app.post(
    "/api/capsules/:capsuleId/offboard",
    { schema: { params: idParamsSchema("capsuleId"), body: offboardBodySchema } },
    async (request) => {
      const actor = await authenticate(request, store);
      requireGovernanceAdmin(store, actor);
      const { capsuleId } = request.params as { capsuleId: string };
      const body = (request.body ?? {}) as { cascade?: boolean };
      const result = mutateAndPersist(() => domainCall(
        () => offboardCapsule(store, { capsuleId, actorId: actor.sub, cascade: body.cascade }),
      ));
      return result;
    },
  );

  app.post(
    "/api/capsules/:capsuleId/members",
    { schema: { params: idParamsSchema("capsuleId"), body: membershipBodySchema } },
    async (request) => {
      const actor = await authenticate(request, store);
      requireGovernanceAdmin(store, actor);
      const { capsuleId } = request.params as { capsuleId: string };
      const { principalId } = request.body as { principalId: string };
      if (capsuleId !== "control-plane") {
        fail(
          409,
          "approval_workflow_required",
          "business and data memberships require an approved role request",
        );
      }
      mutateAndPersist(() => domainCall(() => addMembership(store, actor.sub, principalId, capsuleId)));
      return { ok: true, principal: publicPrincipal(store, principalId) };
    },
  );

  app.delete(
    "/api/capsules/:capsuleId/members/:principalId",
    { schema: { params: membershipParamsSchema } },
    async (request) => {
      const actor = await authenticate(request, store);
      requireGovernanceAdmin(store, actor);
      const { capsuleId, principalId } = request.params as { capsuleId: string; principalId: string };
      mutateAndPersist(() => domainCall(() => removeMembership(store, actor.sub, principalId, capsuleId)));
      return { ok: true };
    },
  );

  app.get("/api/jit", { schema: { querystring: paginationQuerySchema } }, async (request) => {
    const actor = await authenticate(request, store);
    const admin = isControlPlaneAdmin(store, actor.sub);
    if (admin) requireGovernanceAdmin(store, actor);
    let grants = admin
      ? store.jit
      : store.jit.filter((grant) => grant.principalId === actor.sub || grant.requesterId === actor.sub);
    if (!admin && actor.purpose !== undefined) grants = grants.filter((grant) => grant.purpose === actor.purpose);
    const metadata = new Map(state.jitMetadata.map((item) => [item.jitId, item]));
    const visible = grants.map((grant) => ({ ...grant, ...metadata.get(grant.id) }));
    const result = page(visible, request.query as { cursor?: number; limit?: number });
    return { grants: result.items, nextCursor: result.nextCursor, total: result.total };
  });

  app.post("/api/jit", { schema: { body: jitRequestBodySchema } }, async (request) => {
    const actor = await authenticate(request, store);
    const body = request.body as {
      datasetId: string;
      capsuleId: string;
      purpose: string;
      contractId?: string;
      actions?: Action[];
      justification: string;
      durationMs: number;
      ticket?: string;
    };
    requireTokenPurpose(actor, body.purpose);
    const grant = mutateAndPersist(() => {
      const created = domainCall(
        () => requestJit(store, {
          requesterId: actor.sub,
          principalId: actor.sub,
          datasetId: body.datasetId,
          capsuleId: body.capsuleId,
          purpose: body.purpose,
          actions: body.actions,
          contractId: body.contractId,
          justification: body.justification,
          requestedTtlMs: body.durationMs,
          ticket: body.ticket,
          trustedAuthenticationAssurance: actor.authenticationAssurance,
        }),
        { code: "jit_request_rejected", message: "JIT request rejected" },
      );
      state.jitMetadata.push({
        jitId: created.id,
        justification: body.justification.trim(),
        requestedTtlMs: body.durationMs,
      });
      return created;
    });
    return { ...grant, justification: body.justification.trim(), requestedTtlMs: body.durationMs };
  });

  app.post(
    "/api/jit/:jitId/approve",
    { schema: { params: idParamsSchema("jitId"), body: jitApproveBodySchema } },
    async (request) => {
      const actor = await authenticate(request, store);
      requireGovernanceAdmin(store, actor);
      const { jitId } = request.params as { jitId: string };
      const body = (request.body ?? {}) as { ttlMs?: number };
      const metadata = state.jitMetadata.find((item) => item.jitId === jitId);
      const ttlMs = body.ttlMs ?? metadata?.requestedTtlMs ?? DEFAULT_JIT_TTL_MS;
      if (metadata && ttlMs > metadata.requestedTtlMs) {
        fail(400, "ttl_exceeds_request", "approval TTL cannot exceed requested duration");
      }
      const grant = mutateAndPersist(
        () => domainCall(() => approveJit(store, {
          jitId,
          approverId: actor.sub,
          ttlMs,
          trustedAuthenticationAssurance: actor.authenticationAssurance,
        })),
      );
      return grant;
    },
  );

  app.post(
    "/api/jit/:jitId/deny",
    { schema: { params: idParamsSchema("jitId"), body: jitRevokeBodySchema } },
    async (request) => {
      const actor = await authenticate(request, store);
      requireGovernanceAdmin(store, actor);
      const { jitId } = request.params as { jitId: string };
      const { reason } = request.body as { reason: string };
      return mutateAndPersist(() => domainCall(() => denyJit(store, {
        jitId,
        denierId: actor.sub,
        reason,
      })));
    },
  );

  app.post(
    "/api/jit/:jitId/revoke",
    { schema: { params: idParamsSchema("jitId"), body: jitRevokeBodySchema } },
    async (request) => {
      const actor = await authenticate(request, store);
      const { jitId } = request.params as { jitId: string };
      const { reason } = request.body as { reason: string };
      const existing = store.jit.find((grant) => grant.id === jitId);
      if (!existing) fail(404, "jit_not_found", "JIT grant not found");
      const admin = isControlPlaneAdmin(store, actor.sub);
      if (admin) requireGovernanceAdmin(store, actor);
      else requireTokenPurpose(actor, existing.purpose);
      return mutateAndPersist(() => domainCall(
        () => revokeJit(store, {
          jitId,
          actorId: actor.sub,
          reason,
        }),
        admin ? undefined : { code: "jit_revoke_rejected", message: "JIT revoke rejected" },
      ));
    },
  );

  app.get("/api/audit", { schema: { querystring: paginationQuerySchema } }, async (request) => {
    const actor = await authenticate(request, store);
    requireGovernanceAdmin(store, actor);
    const result = page([...store.audit].reverse(), request.query as { cursor?: number; limit?: number });
    return { events: result.items, nextCursor: result.nextCursor, total: result.total };
  });

  app.post("/api/store/reset", async (request) => {
    const actor = await authenticate(request, store);
    requireGovernanceAdmin(store, actor);
    if (!demoMode) fail(404, "not_found", "not found");
    mutateAndPersist(() => {
      store.restore(seedStore().snapshot());
      state.roleRequests = [];
      state.jitMetadata = [];
      state.recertifications = [];
      store.appendAudit(actor.sub, "store.reset", {});
    });
    return { ok: true };
  });

  app.get("/api/governance/sod/rules", async (request) => {
    const actor = await authenticate(request, store);
    requireGovernanceReviewer(store, actor);
    return {
      policy: "warehouse-separation-of-duties",
      failClosed: true,
      rules: WAREHOUSE_SOD_RULES,
    };
  });

  app.get(
    "/api/governance/sod/violations",
    { schema: { querystring: sodViolationsQuerySchema } },
    async (request) => {
      const actor = await authenticate(request, store);
      requireGovernanceReviewer(store, actor);
      const query = request.query as { principalId?: string; cursor?: number; limit?: number };
      if (query.principalId && !store.principals.has(query.principalId)) {
        fail(404, "principal_not_found", "principal not found");
      }
      const principals = query.principalId
        ? [query.principalId]
        : [...store.principals.values()]
            .filter((principal) => principal.kind === "human" && !principal.disabled)
            .map((principal) => principal.id);
      const violations = principals.flatMap((principalId) => evaluatePrincipalSod(store, principalId));
      const result = page(violations, query);
      return {
        violations: result.items,
        nextCursor: result.nextCursor,
        total: result.total,
        evaluatedPrincipals: principals.length,
        policyRules: WAREHOUSE_SOD_RULES.map((rule) => `${rule.id}@${rule.version}`),
      };
    },
  );

  app.get(
    "/api/recertifications",
    { schema: { querystring: recertificationListQuerySchema } },
    async (request) => {
      const actor = await authenticate(request, store);
      requireGovernanceReviewer(store, actor);
      mutateAndPersist(() => refreshRecertifications(store, state.recertifications));
      const query = request.query as {
        status?: RecertificationCampaign["status"];
        cursor?: number;
        limit?: number;
      };
      const visible = [...state.recertifications]
        .reverse()
        .filter((campaign) => query.status === undefined || campaign.status === query.status)
        .map(recertificationCampaignSummary);
      const result = page(visible, query);
      return { campaigns: result.items, nextCursor: result.nextCursor, total: result.total };
    },
  );

  app.post(
    "/api/recertifications",
    { schema: { body: recertificationCreateBodySchema } },
    async (request) => {
      const actor = await authenticate(request, store);
      requireGovernanceAdmin(store, actor);
      const body = request.body as { name: string; dueAt: number; cadenceDays: number };
      if (state.recertifications.some((campaign) =>
        campaign.status === "active" && campaign.name.toLowerCase() === body.name.trim().toLowerCase()
      )) {
        fail(409, "recertification_campaign_exists", "an active campaign with this name already exists");
      }
      const now = Date.now();
      const campaign = domainCall(() => createRecertificationCampaign(store, {
        name: body.name,
        createdBy: actor.sub,
        dueAt: body.dueAt,
        cadenceDays: body.cadenceDays,
        now,
      }));
      mutateAndPersist(() => {
        state.recertifications.push(campaign);
        store.appendAudit(actor.sub, "recertification.campaign.create", {
          campaignId: campaign.id,
          name: campaign.name,
          dueAt: campaign.dueAt,
          cadenceDays: campaign.cadenceDays,
          itemCount: campaign.items.length,
          scope: "active-human-memberships",
        }, now);
      });
      return { ...recertificationCampaignSummary(campaign), items: campaign.items };
    },
  );

  app.post(
    "/api/recertifications/:campaignId/renew",
    { schema: { params: idParamsSchema("campaignId") } },
    async (request) => {
      const actor = await authenticate(request, store);
      requireGovernanceAdmin(store, actor);
      const { campaignId } = request.params as { campaignId: string };
      mutateAndPersist(() => refreshRecertifications(store, state.recertifications));
      const prior = state.recertifications.find((campaign) => campaign.id === campaignId);
      if (!prior) fail(404, "recertification_not_found", "recertification campaign not found");
      if (prior.status === "active") {
        fail(409, "recertification_still_active", "active campaign cannot be renewed");
      }
      if (state.recertifications.some((campaign) => campaign.previousCampaignId === prior.id)) {
        fail(409, "recertification_already_renewed", "campaign has already been renewed");
      }
      const now = Date.now();
      const dueAt = now + prior.cadenceDays * DAY_MS;
      const campaign = domainCall(() => createRecertificationCampaign(store, {
        name: prior.name,
        createdBy: actor.sub,
        dueAt,
        cadenceDays: prior.cadenceDays,
        now,
        previousCampaignId: prior.id,
      }));
      mutateAndPersist(() => {
        state.recertifications.push(campaign);
        store.appendAudit(actor.sub, "recertification.campaign.renew", {
          campaignId: campaign.id,
          previousCampaignId: prior.id,
          dueAt: campaign.dueAt,
          cadenceDays: campaign.cadenceDays,
          itemCount: campaign.items.length,
        }, now);
      });
      return { ...recertificationCampaignSummary(campaign), items: campaign.items };
    },
  );

  app.get(
    "/api/recertifications/:campaignId/items",
    { schema: {
      params: idParamsSchema("campaignId"),
      querystring: recertificationItemsQuerySchema,
    } },
    async (request) => {
      const actor = await authenticate(request, store);
      requireGovernanceReviewer(store, actor);
      mutateAndPersist(() => refreshRecertifications(store, state.recertifications));
      const { campaignId } = request.params as { campaignId: string };
      const campaign = state.recertifications.find((item) => item.id === campaignId);
      if (!campaign) fail(404, "recertification_not_found", "recertification campaign not found");
      const query = request.query as {
        status?: RecertificationItem["status"];
        cursor?: number;
        limit?: number;
      };
      const visible = campaign.items.filter((item) => query.status === undefined || item.status === query.status);
      const result = page(visible, query);
      return {
        campaign: recertificationCampaignSummary(campaign),
        items: result.items,
        nextCursor: result.nextCursor,
        total: result.total,
      };
    },
  );

  app.get(
    "/api/recertifications/:campaignId/evidence",
    { schema: { params: idParamsSchema("campaignId") } },
    async (request) => {
      const actor = await authenticate(request, store);
      requireGovernanceReviewer(store, actor);
      mutateAndPersist(() => refreshRecertifications(store, state.recertifications));
      const { campaignId } = request.params as { campaignId: string };
      const campaign = state.recertifications.find((item) => item.id === campaignId);
      if (!campaign) fail(404, "recertification_not_found", "recertification campaign not found");
      return {
        campaign: recertificationCampaignSummary(campaign),
        decisions: campaign.items
          .filter((item) => item.status !== "pending")
          .map((item) => ({
            itemId: item.id,
            principalId: item.principalId,
            capsuleId: item.capsuleId,
            personaId: item.personaId,
            assignmentId: item.assignmentId,
            status: item.status,
            decidedAt: item.decidedAt,
            decidedBy: item.decidedBy,
            reviewerRole: item.reviewerRole,
            reason: item.reason,
            evidence: item.evidence,
          })),
        auditChainValid: store.verifyAuditChain(),
      };
    },
  );

  for (const decision of ["attest", "revoke"] as const) {
    app.post(
      `/api/recertifications/:campaignId/items/:itemId/${decision}`,
      { schema: {
        params: recertificationItemParamsSchema,
        body: recertificationDecisionBodySchema,
      } },
      async (request) => {
        const actor = await authenticate(request, store);
        const reviewerRole = requireGovernanceReviewer(store, actor);
        mutateAndPersist(() => refreshRecertifications(store, state.recertifications));
        const { campaignId, itemId } = request.params as { campaignId: string; itemId: string };
        const { reason } = request.body as { reason: string };
        const campaign = state.recertifications.find((item) => item.id === campaignId);
        if (!campaign) fail(404, "recertification_not_found", "recertification campaign not found");
        if (campaign.status !== "active") {
          fail(409, "recertification_not_active", "only active campaigns accept decisions");
        }
        const item = campaign.items.find((candidate) => candidate.id === itemId);
        if (!item) fail(404, "recertification_item_not_found", "recertification item not found");
        if (item.status !== "pending") {
          fail(409, "recertification_item_decided", "recertification item has already been decided");
        }
        if (actor.sub === item.principalId) {
          fail(409, "self_review_forbidden", "reviewers cannot decide their own access");
        }
        if (!item.eligibleReviewerRoles.includes(reviewerRole)) {
          fail(403, "reviewer_not_eligible", "reviewer is not eligible for this access item");
        }
        const now = Date.now();
        mutateAndPersist(() => {
          if (decision === "revoke") {
            domainCall(() => revokeMembershipForRecertification(store, {
              reviewerId: actor.sub,
              principalId: item.principalId,
              capsuleId: item.capsuleId,
              campaignId: campaign.id,
              itemId: item.id,
              assignmentId: item.assignmentId,
              reason,
              now,
            }));
          }
          const audit = store.appendAudit(actor.sub, `recertification.item.${decision}`, {
            campaignId: campaign.id,
            itemId: item.id,
            principalId: item.principalId,
            capsuleId: item.capsuleId,
            personaId: item.personaId,
            reviewerRole,
            reason: reason.trim(),
            membershipFingerprint: membershipFingerprint(item),
          }, now);
          item.status = decision === "attest" ? "attested" : "revoked";
          item.decidedAt = now;
          item.decidedBy = actor.sub;
          item.reviewerRole = reviewerRole;
          item.reason = reason.trim();
          item.evidence = {
            auditSeq: audit.seq,
            auditHash: audit.hash,
            membershipFingerprint: membershipFingerprint(item),
          };
          if (!campaign.items.some((candidate) => candidate.status === "pending")) {
            campaign.status = "completed";
            store.appendAudit(actor.sub, "recertification.campaign.complete", {
              campaignId: campaign.id,
              itemCount: campaign.items.length,
            }, now);
          }
        });
        return { campaign: recertificationCampaignSummary(campaign), item };
      },
    );
  }

  app.get("/api/roles/palette", async (request) => {
    const actor = await authenticate(request, store);
    if (isControlPlaneAdmin(store, actor.sub)) {
      requireGovernanceAdmin(store, actor);
      return { palette: ROLE_PALETTE };
    }
    if (actor.purpose !== undefined) {
      return {
        palette: {
          ...ROLE_PALETTE,
          purposes: ROLE_PALETTE.purposes.filter((purpose) => purpose.id === actor.purpose),
        },
      };
    }
    return { palette: ROLE_PALETTE };
  });

  app.get(
    "/api/dashboard",
    { schema: { querystring: purposeQuerySchema } },
    async (request) => {
      const actor = await authenticate(request, store);
      const { purpose } = request.query as { purpose: string };
      requireTokenPurpose(actor, purpose);
      const result = dashboardFor(
        store,
        warehouse,
        actor.sub,
        purpose,
        isWarehouseDataOwner(store, actor.sub),
      );
      mutateAndPersist(() => {
        store.appendAudit(actor.sub, "warehouse.dashboard", { purpose, visible: result.visible });
      });
      return result;
    },
  );

  app.get(
    "/api/warehouse/records",
    { schema: { querystring: warehousePageQuerySchema } },
    async (request) => {
      const actor = await authenticate(request, store);
      const { purpose, cursor, limit } = request.query as {
        purpose: string;
        cursor: number;
        limit: number;
      };
      requireTokenPurpose(actor, purpose);
      const dataset = store.datasets.get("warehouse");
      if (!dataset || dataset.controlPlane) fail(404, "dataset_not_found", "warehouse dataset not found");

      const scopes = warehouseScopesFor(store, actor.sub, purpose);
      const allowedFields = allowedFieldsForScopes(scopes);
      const denyFields = [...new Set(scopes.flatMap((scope) => scope.denyFields))].sort();
      const contractIds = [...new Set(scopes.map((scope) => scope.contractId))].sort();
      const capsuleIds = [...new Set(scopes.map((scope) => scope.capsuleId))].sort();
      const effectiveAssignments = store.liveMembershipsFor(actor.sub)
        .filter(({ capsule }) => capsuleIds.includes(capsule.id))
        .map(({ capsule, persona }) => ({
          capsuleId: capsule.id,
          capsuleLabel: capsule.label,
          personaId: persona.id,
          personaLabel: persona.label,
        }))
        .filter((assignment, index, assignments) => assignments.findIndex((candidate) =>
          candidate.capsuleId === assignment.capsuleId && candidate.personaId === assignment.personaId
        ) === index)
        .sort((left, right) => left.capsuleId.localeCompare(right.capsuleId) || left.personaId.localeCompare(right.personaId));
      const result = warehouse.page(
        scopesToFilter(scopes.map(toDataScope)),
        allowedFields,
        denyFields,
        cursor,
        limit,
      );
      const effect = scopes.length > 0 && !result.denied ? "allow" as const : "deny" as const;
      const reason = scopes.length === 0
        ? "no_contract_binding"
        : result.fields.length === 0 ? "contract_field_allowlist_empty" : "contract_allow";
      const includeGlobalTotal = actor.persona === "data-owner"
        && contractIds.includes("wh.data-owner")
        && capsuleIds.includes("data-governance-owner");
      const datasetMetadata = {
        id: dataset.id,
        name: dataset.name,
        origin: dataset.origin,
        design: dataset.design,
        classification: dataset.classification,
        controlPlane: dataset.controlPlane,
      };
      const responseDataset = effect === "allow"
        ? { ...datasetMetadata, allowedFields: [...result.fields] }
        : datasetMetadata;
      const audit = mutateAndPersist(() => store.appendAudit(actor.sub, "warehouse.data.read", {
        purpose,
        effect,
        reason,
        visible: result.visible,
        returned: result.records.length,
        cursor,
        limit,
        contractIds,
        capsuleIds,
      }));

      return {
        dataset: responseDataset,
        purpose,
        visible: result.visible,
        ...(includeGlobalTotal ? { total: warehouse.count() } : {}),
        records: result.records,
        ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
        facets: result.facets,
        lineage: result.lineage,
        receipt: {
          subjectId: actor.sub,
          personaId: actor.persona,
          tokenPersonaId: actor.persona,
          effectiveAssignments,
          effect,
          reason,
          contractIds,
          capsuleIds,
          allowedFields: [...result.fields],
          denyFields: includeGlobalTotal ? denyFields : [],
          protectedFieldCount: denyFields.length,
          auditSeq: audit.seq,
          auditHash: audit.hash,
        },
      };
    },
  );

  app.post("/api/roles/from-ask", { schema: { body: askBodySchema } }, async (request) => {
    const actor = await authenticate(request, store);
    const { ask } = request.body as { ask: string };
    const parsed = parseNeedToRole(ask);
    if (isControlPlaneAdmin(store, actor.sub)) requireGovernanceAdmin(store, actor);
    else requireTokenPurpose(actor, parsed.draft.purpose);
    const preview = previewRole(store, warehouse, actor, parsed.draft);
    const errors = validateRoleDraft(parsed.draft);
    const sodViolations = errors.length === 0
      ? evaluateRoleDraftSod(store, actor.sub, parsed.draft)
      : [];
    return { ...parsed, preview, errors, sodViolations };
  });

  app.post("/api/roles/preview", { schema: { body: roleDraftBodySchema } }, async (request) => {
    const actor = await authenticate(request, store);
    const { draft, principalId = actor.sub } = request.body as { draft: RoleDraft; principalId?: string };
    if (isControlPlaneAdmin(store, actor.sub)) requireGovernanceAdmin(store, actor);
    else requireTokenPurpose(actor, draft.purpose);
    if (principalId !== actor.sub && !isControlPlaneAdmin(store, actor.sub)) {
      fail(403, "self_preview_only", "users may preview roles only for themselves");
    }
    const target = store.principals.get(principalId);
    if (!target || target.disabled) fail(404, "principal_not_found", "active principal not found");
    const errors = validateRoleDraft(draft);
    return {
      ...previewRole(store, warehouse, actor, draft),
      errors,
      sodEvaluatedPrincipalId: principalId,
      sodViolations: errors.length === 0 ? evaluateRoleDraftSod(store, principalId, draft) : [],
    };
  });

  app.get("/api/role-requests", { schema: { querystring: paginationQuerySchema } }, async (request) => {
    const actor = await authenticate(request, store);
    const reviewerRole = governanceReviewerRoleFor(store, actor.sub);
    if (reviewerRole) requireGovernanceReviewer(store, actor);
    let visible = reviewerRole
      ? state.roleRequests
      : state.roleRequests.filter((item) => item.requesterId === actor.sub || item.principalId === actor.sub);
    if (!reviewerRole && actor.purpose !== undefined) {
      visible = visible.filter((item) => item.draft.purpose === actor.purpose);
    }
    const result = page([...visible].reverse(), request.query as { cursor?: number; limit?: number });
    return { requests: result.items, nextCursor: result.nextCursor, total: result.total };
  });

  app.post("/api/role-requests", { schema: { body: roleRequestBodySchema } }, async (request) => {
    const actor = await authenticate(request, store);
    const body = request.body as { draft: RoleDraft; principalId?: string };
    const admin = isControlPlaneAdmin(store, actor.sub);
    const principalId = body.principalId ?? actor.sub;
    if (admin) requireGovernanceAdmin(store, actor);
    else requireTokenPurpose(actor, body.draft.purpose);
    if (!admin && principalId !== actor.sub) fail(403, "self_request_only", "users may request roles only for themselves");
    const target = store.principals.get(principalId);
    if (!target || target.disabled) fail(404, "principal_not_found", "active principal not found");
    if (isControlPlaneAdmin(store, principalId)) {
      fail(409, "admin_role_protected", "control-plane administrator roles cannot be replaced");
    }
    const errors = validateRoleDraft(body.draft);
    if (errors.length > 0) fail(400, "invalid_role_draft", errors.join("; "));
    const sodViolations = evaluateRoleDraftSod(store, principalId, body.draft);
    if (sodViolations.length > 0) {
      failWithDetails(
        409,
        "sod_policy_violation",
        "separation-of-duties policy blocked this role request",
        { violations: sodViolations },
      );
    }
    ensureIndependentRoleReviewers(store, actor.sub, principalId);
    if (state.roleRequests.some((item) =>
      item.status === "pending"
      && item.principalId === principalId
      && item.draft.name.trim().toLowerCase() === body.draft.name.trim().toLowerCase()
    )) {
      fail(409, "duplicate_request", "a matching role request is already pending");
    }
    const roleRequest: RoleRequest = {
      id: `role-request-${randomUUID()}`,
      requesterId: actor.sub,
      principalId,
      status: "pending",
      draft: structuredClone(body.draft),
      createdAt: Date.now(),
      approvalPolicyVersion: 2,
      requiredApprovals: [...ROLE_REQUEST_REQUIRED_APPROVALS],
      approvals: [],
    };
    mutateAndPersist(() => {
      state.roleRequests.push(roleRequest);
      store.appendAudit(actor.sub, "role.request", {
        id: roleRequest.id,
        principalId,
        draft: body.draft,
        approvalPolicyVersion: roleRequest.approvalPolicyVersion,
        requiredApprovals: roleRequest.requiredApprovals,
        sodRulesEvaluated: WAREHOUSE_SOD_RULES.map((rule) => `${rule.id}@${rule.version}`),
      });
    });
    return roleRequest;
  });

  app.post(
    "/api/role-requests/:requestId/approve",
    { schema: { params: idParamsSchema("requestId") } },
    async (request) => {
      const actor = await authenticate(request, store);
      const reviewerRole = requireGovernanceReviewer(store, actor);
      const { requestId } = request.params as { requestId: string };
      const roleRequest = state.roleRequests.find((item) => item.id === requestId);
      if (!roleRequest) fail(404, "role_request_not_found", "role request not found");
      if (roleRequest.status !== "pending") fail(409, "role_request_decided", "role request is already decided");
      requireIndependentReviewer(actor.sub, roleRequest);
      if (isControlPlaneAdmin(store, roleRequest.principalId)) {
        fail(409, "admin_role_protected", "control-plane administrator roles cannot be replaced");
      }
      if (!roleRequest.requiredApprovals.includes(reviewerRole)) {
        fail(403, "reviewer_not_required", "this reviewer role is not required by the approval policy");
      }
      if (roleRequest.approvals.some((approval) => approval.reviewerId === actor.sub)) {
        fail(409, "approval_already_recorded", "this reviewer has already decided the request");
      }
      if (roleRequest.approvals.some((approval) => approval.reviewerRole === reviewerRole)) {
        fail(409, "approval_already_recorded", "this reviewer role has already decided the request");
      }
      const sodViolations = evaluateRoleDraftSod(store, roleRequest.principalId, roleRequest.draft);
      if (sodViolations.length > 0) {
        failWithDetails(
          409,
          "sod_policy_violation",
          "separation-of-duties policy blocked this approval",
          { violations: sodViolations },
        );
      }
      const now = Date.now();
      const approval = {
        reviewerId: actor.sub,
        reviewerRole,
        decision: "approved" as const,
        decidedAt: now,
      };
      const approvalsAfter = [...roleRequest.approvals, approval];
      const complete = roleRequest.requiredApprovals.every((required) =>
        approvalsAfter.some((item) => item.reviewerRole === required && item.decision === "approved")
      );
      const staleApprovals = approvalsAfter.filter((item) =>
        !reviewerHasRole(store, item.reviewerId, item.reviewerRole)
      );
      if (staleApprovals.length > 0) {
        failWithDetails(
          409,
          "approval_stale",
          "one or more reviewers no longer hold the role used for approval",
          { reviewers: staleApprovals.map((item) => item.reviewerId) },
        );
      }
      mutateAndPersist(() => {
        let applied = roleRequest.applied;
        if (complete) {
          const adminApproval = approvalsAfter.find((item) => item.reviewerRole === "governance-admin");
          if (!adminApproval) throw new Error("required governance administrator approval missing");
          applied = domainCall(() => applyRoleDraft(store, {
            actorId: adminApproval.reviewerId,
            principalId: roleRequest.principalId,
            draft: roleRequest.draft,
          }));
        }
        roleRequest.approvals.push(approval);
        if (complete) {
          roleRequest.status = "approved";
          roleRequest.reviewedAt = now;
          roleRequest.reviewerId = actor.sub;
          roleRequest.applied = applied;
        }
        store.appendAudit(actor.sub, "role.request.approve", {
          id: roleRequest.id,
          principalId: roleRequest.principalId,
          reviewerRole,
          completed: complete,
          approvals: approvalsAfter.map((item) => ({
            reviewerId: item.reviewerId,
            reviewerRole: item.reviewerRole,
          })),
        });
      });
      return roleRequest;
    },
  );

  app.post(
    "/api/role-requests/:requestId/deny",
    { schema: { params: idParamsSchema("requestId"), body: roleRequestDecisionBodySchema } },
    async (request) => {
      const actor = await authenticate(request, store);
      const reviewerRole = requireGovernanceReviewer(store, actor);
      const { requestId } = request.params as { requestId: string };
      const { reason } = request.body as { reason: string };
      const roleRequest = state.roleRequests.find((item) => item.id === requestId);
      if (!roleRequest) fail(404, "role_request_not_found", "role request not found");
      if (roleRequest.status !== "pending") fail(409, "role_request_decided", "role request is already decided");
      requireIndependentReviewer(actor.sub, roleRequest);
      if (!roleRequest.requiredApprovals.includes(reviewerRole)) {
        fail(403, "reviewer_not_required", "this reviewer role is not required by the approval policy");
      }
      if (roleRequest.approvals.some((approval) => approval.reviewerId === actor.sub)) {
        fail(409, "approval_already_recorded", "this reviewer has already decided the request");
      }
      if (roleRequest.approvals.some((approval) => approval.reviewerRole === reviewerRole)) {
        fail(409, "approval_already_recorded", "this reviewer role has already decided the request");
      }
      const now = Date.now();
      const denialReason = reason.trim();
      mutateAndPersist(() => {
        roleRequest.approvals.push({
          reviewerId: actor.sub,
          reviewerRole,
          decision: "denied",
          decidedAt: now,
          reason: denialReason,
        });
        roleRequest.status = "denied";
        roleRequest.reviewedAt = now;
        roleRequest.reviewerId = actor.sub;
        roleRequest.reason = denialReason;
        store.appendAudit(actor.sub, "role.request.deny", {
          id: roleRequest.id,
          principalId: roleRequest.principalId,
          reviewerRole,
          reason: roleRequest.reason,
        });
      });
      return roleRequest;
    },
  );

  app.post("/api/roles/apply", { schema: { body: roleApplyBodySchema } }, async (request) => {
    const actor = await authenticate(request, store);
    requireGovernanceAdmin(store, actor);
    fail(
      409,
      "approval_workflow_required",
      "direct role application is disabled; create a role request for data-owner and governance-admin approval",
    );
  });

  app.addHook("onClose", async () => {
    if (opts.ownWarehouse ?? !opts.warehouse) warehouse.close();
    if (persistence && (opts.ownPersistence ?? false)) persistence.close();
  });

  return app;
}

function fullCatalog(store: CcaStore) {
  return {
    personas: [...store.personas.values()],
    capsules: [...store.capsules.values()],
    datasets: [...store.datasets.values()],
    contracts: [...store.contracts.values()],
    bindings: store.bindings,
    principals: [...store.principals.values()].map((principal) => ({
      id: principal.id,
      displayName: principal.displayName,
      username: principal.username,
      personaId: principal.personaId,
      kind: principal.kind,
      disabled: principal.disabled,
    })),
    memberships: store.memberships,
  };
}

function scopedCatalog(store: CcaStore, principalId: string, trustedPurpose?: string) {
  const principal = store.principals.get(principalId)!;
  const liveCapsules = store.liveCapsulesFor(principalId);
  const liveCapsuleIds = new Set(liveCapsules.map((capsule) => capsule.id));
  const bindings = store.bindings.filter((binding) => {
    if (!liveCapsuleIds.has(binding.capsuleId)) return false;
    if (trustedPurpose === undefined) return true;
    return store.contracts.get(binding.contractId)?.purpose === trustedPurpose;
  });
  const visibleCapsuleIds = trustedPurpose === undefined
    ? liveCapsuleIds
    : new Set(bindings.map((binding) => binding.capsuleId));
  const capsules = liveCapsules.filter((capsule) => visibleCapsuleIds.has(capsule.id));
  const contractIds = new Set(bindings.map((binding) => binding.contractId));
  const contracts = [...store.contracts.values()].filter((contract) => contractIds.has(contract.id));
  const datasetIds = new Set(contracts.map((contract) => contract.datasetId));
  return {
    personas: [store.personas.get(principal.personaId)].filter(Boolean),
    capsules,
    datasets: [...store.datasets.values()].filter((dataset) => datasetIds.has(dataset.id)),
    contracts,
    bindings,
    principals: [{
      id: principal.id,
      displayName: principal.displayName,
      username: principal.username,
      personaId: principal.personaId,
      kind: principal.kind,
      disabled: principal.disabled,
    }],
    memberships: store.memberships.filter(
      (membership) => membership.principalId === principalId && visibleCapsuleIds.has(membership.capsuleId),
    ),
  };
}

function isWarehouseDataOwner(store: CcaStore, principalId: string): boolean {
  const configuredOwners = store.datasets.get("warehouse")?.ownerPrincipalIds;
  if (configuredOwners !== undefined && !configuredOwners.includes(principalId)) return false;
  return store.liveMembershipsFor(principalId).some(({ capsule, persona }) =>
    capsule.id === "data-governance-owner" && persona.id === "data-owner"
  );
}

function dashboardFor(
  store: CcaStore,
  warehouse: Warehouse,
  principalId: string,
  purpose: string,
  includeGlobalTotal = false,
) {
  const scopes = warehouseScopesFor(store, principalId, purpose);
  const filter = scopesToFilter(scopes.map(toDataScope));
  const allowedFields = allowedFieldsForScopes(scopes);
  const denyFields = [...new Set(scopes.flatMap((scope) => scope.denyFields))];
  const result = { ...warehouse.query(filter, allowedFields, denyFields), scopes, purpose };
  if (includeGlobalTotal) return result;
  const { total: _globalTotal, ...authorized } = result;
  return authorized;
}

function previewRole(store: CcaStore, warehouse: Warehouse, actor: AccessToken, draft: RoleDraft) {
  const requested = scopeFromDraft(draft);
  const admin = isControlPlaneAdmin(store, actor.sub);
  const actorScopes = admin ? [] : warehouseScopesFor(store, actor.sub, draft.purpose);
  const scopes = admin
    ? [requested]
    : actorScopes.flatMap((scope) => {
        const intersection = intersectScope(requested, toDataScope(scope));
        return intersection ? [intersection] : [];
      });
  const denyFields = admin
    ? [...new Set(draft.denyFields)]
    : [...new Set([...draft.denyFields, ...actorScopes.flatMap((scope) => scope.denyFields)])];
  const allowedFields = admin
    ? [...WAREHOUSE_ALLOWED_FIELDS]
    : allowedFieldsForScopes(actorScopes);
  const result = warehouse.query(scopesToFilter(scopes), allowedFields, denyFields, 0);
  const preview = {
    visible: result.visible,
    byProduct: result.byProduct.map(({ key, count }) => ({ key, count })),
    byRegion: result.byRegion,
    byDepartment: result.byDepartment,
    bySensitivity: result.bySensitivity,
    byDay: [],
    sample: [],
    denied: result.denied,
    previewMode: "metadata",
    constrainedToActor: !admin,
  };
  return admin ? { ...preview, total: result.total } : preview;
}

function allowedFieldsForScopes(scopes: Array<{ allowedFields: string[] }>): string[] {
  if (scopes.length === 0) return [];
  return scopes.reduce<string[]>(
    (allowed, scope) => intersectFieldPaths(allowed, scope.allowedFields),
    [...WAREHOUSE_ALLOWED_FIELDS],
  );
}

function toDataScope(scope: {
  products: string[];
  tenants: string[];
  regions: string[];
  departments: string[];
  sources: string[];
  ceiling: Classification;
}): DataScope {
  return {
    products: scope.products,
    tenants: scope.tenants,
    regions: scope.regions,
    departments: scope.departments,
    sources: scope.sources,
    ceiling: scope.ceiling,
  };
}

function intersectScope(requested: DataScope, allowed: DataScope): DataScope | undefined {
  const products = intersectValues(requested.products, allowed.products);
  const tenants = intersectValues(requested.tenants, allowed.tenants);
  const regions = intersectValues(requested.regions, allowed.regions);
  const departments = intersectValues(requested.departments, allowed.departments);
  const sources = intersectValues(requested.sources, allowed.sources);
  if (!products || !tenants || !regions || !departments || !sources) return undefined;
  return {
    products,
    tenants,
    regions,
    departments,
    sources,
    ceiling: CLASS_RANK[requested.ceiling] <= CLASS_RANK[allowed.ceiling]
      ? requested.ceiling
      : allowed.ceiling,
  };
}

function intersectValues(requested: string[], allowed: string[]): string[] | undefined {
  if (allowed.length === 0) return [...requested];
  if (requested.length === 0) return [...allowed];
  const allowedSet = new Set(allowed);
  const intersection = requested.filter((value) => allowedSet.has(value));
  return intersection.length > 0 ? intersection : undefined;
}

export const JIT_TTL_BOUNDS = {
  minimum: MIN_JIT_TTL_MS,
  maximum: MAX_JIT_TTL_MS,
};
