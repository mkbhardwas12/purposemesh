import { compileCapsule } from "./compiler.js";
import { randomUUID } from "node:crypto";
import { sha256 } from "./crypto.js";
import { isAdminPersona, personaMatchesContract } from "./pdp.js";
import { canonicalFieldPaths, intersectFieldPaths } from "./predicate.js";
import { evaluateRoleDraftSod, SodPolicyViolationError } from "./governance.js";
import {
  WAREHOUSE_ALLOWED_FIELDS,
  draftToPredicate,
  validateRoleDraft,
  type RoleDraft,
} from "./role-draft.js";
import type { CcaStore } from "./store.js";
import { CLASS_RANK, type Action, type Capsule, type Classification, type Predicate } from "./types.js";

export const DEFAULT_JIT_TTL_MS = 60 * 60 * 1000;
export const MIN_JIT_TTL_MS = 1_000;
export const MAX_JIT_TTL_MS = 8 * 60 * 60 * 1000;

const JIT_DENY_FIELDS = [
  "payload",
  "bank_account",
  "account_number",
  "s4.vendor_bank",
  "tax_id",
  "legal_name",
] as const;

export function isControlPlaneAdmin(store: CcaStore, principalId: string): boolean {
  const principal = store.principals.get(principalId);
  if (!principal || principal.disabled) return false;
  if (!isAdminPersona(store.personas.get(principal.personaId))) return false;
  return store.liveCapsulesFor(principalId).some((capsule) => capsule.id === "control-plane");
}

export type GovernanceReviewerRole = "data-owner" | "governance-admin";

export function isWarehouseDataOwner(store: CcaStore, principalId: string): boolean {
  const principal = store.principals.get(principalId);
  if (!principal || principal.disabled || principal.kind !== "human") return false;
  const configuredOwners = store.datasets.get("warehouse")?.ownerPrincipalIds;
  if (configuredOwners !== undefined && !configuredOwners.includes(principalId)) return false;
  return store.liveMembershipsFor(principalId).some(({ capsule, persona }) =>
    capsule.id === "data-governance-owner" && persona.id === "data-owner"
  );
}

export function governanceReviewerRoleFor(
  store: CcaStore,
  principalId: string,
): GovernanceReviewerRole | undefined {
  if (isControlPlaneAdmin(store, principalId)) return "governance-admin";
  if (isWarehouseDataOwner(store, principalId)) return "data-owner";
  return undefined;
}

export function recertificationReviewerRolesFor(
  store: CcaStore,
  principalId: string,
  capsuleId: string,
): GovernanceReviewerRole[] {
  const principal = store.principals.get(principalId);
  const membership = store.memberships.find((item) =>
    item.principalId === principalId && item.capsuleId === capsuleId
  );
  const persona = membership
    ? store.personas.get(membership.personaId ?? principal?.personaId ?? "")
    : undefined;
  if (!principal || principal.kind !== "human" || !membership || !persona) return [];
  // Privileged administrators are attested by a data owner; data-owner access is
  // attested by an administrator. All other data access may be reviewed by either.
  if (capsuleId === "control-plane" || persona.id === "admin") return ["data-owner"];
  if (persona.id === "data-owner") return ["governance-admin"];
  return ["data-owner", "governance-admin"];
}

export function membershipAssignmentId(membership: {
  principalId: string;
  capsuleId: string;
  personaId?: string;
  assignmentId?: string;
}): string {
  return membership.assignmentId ?? `legacy-assignment.${sha256(JSON.stringify({
    principalId: membership.principalId,
    capsuleId: membership.capsuleId,
    personaId: membership.personaId ?? null,
  })).slice(0, 24)}`;
}

function requireControlPlaneAdmin(store: CcaStore, principalId: string): void {
  if (!isControlPlaneAdmin(store, principalId)) {
    throw new Error("platform admin with active control-plane membership required");
  }
}

function requireTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

export type OffboardResult = {
  capsuleId: string;
  cascaded: string[];
  removedMembers: string[];
  removedBindings: string[];
  expiredJit: string[];
  revokedNative: ReturnType<typeof compileCapsule>[];
};

export function offboardCapsule(
  store: CcaStore,
  input: {
    capsuleId: string;
    actorId: string;
    cascade?: boolean;
    now?: number;
  },
): OffboardResult {
  const { capsuleId, actorId, cascade = false, now = Date.now() } = input;
  requireControlPlaneAdmin(store, actorId);
  requireTime(now, "now");
  if (capsuleId === "control-plane") {
    throw new Error("refusing to offboard the control-plane capsule");
  }
  const root = store.capsules.get(capsuleId);
  if (!root) throw new Error(`unknown capsule ${capsuleId}`);

  const targets = cascade ? store.descendants(capsuleId) : [capsuleId];
  if (targets.includes("control-plane")) {
    throw new Error("refusing to offboard a hierarchy containing the control-plane capsule");
  }
  const revokedNative = targets
    .filter((id) => store.capsules.get(id)?.active)
    .map((id) => compileCapsule(store, id));

  const removedMembers: string[] = [];
  const removedBindings: string[] = [];
  const expiredJit: string[] = [];

  for (const id of targets) {
    const capsule = store.capsules.get(id);
    if (!capsule) continue;
    capsule.active = false;
    const members = store.memberships.filter((m) => m.capsuleId === id);
    removedMembers.push(...members.map((m) => m.principalId));
    store.memberships = store.memberships.filter((m) => m.capsuleId !== id);
    const bindings = store.bindings.filter((b) => b.capsuleId === id);
    removedBindings.push(...bindings.map((b) => b.id));
    store.bindings = store.bindings.filter((b) => b.capsuleId !== id);
    for (const grant of store.jit) {
      if (grant.capsuleId === id && (grant.status === "pending" || grant.status === "approved")) {
        grant.status = "expired";
        grant.expiresAt = now;
        expiredJit.push(grant.id);
      }
    }
  }

  store.appendAudit(actorId, "capsule.offboard", {
    capsuleId,
    cascade,
    targets,
    removedMembers,
    removedBindings,
    expiredJit,
  }, now);

  return {
    capsuleId,
    cascaded: targets,
    removedMembers: [...new Set(removedMembers)],
    removedBindings,
    expiredJit,
    revokedNative,
  };
}

export function addMembership(
  store: CcaStore,
  actorId: string,
  principalId: string,
  capsuleId: string,
): void {
  requireControlPlaneAdmin(store, actorId);
  if (capsuleId !== "control-plane") {
    throw new Error("direct business and data membership grants require the role-request approval workflow");
  }
  const capsule = store.capsules.get(capsuleId);
  if (!capsule?.active) throw new Error("capsule inactive");
  const principal = store.principals.get(principalId);
  if (!principal) throw new Error("unknown principal");
  if (principal.disabled) throw new Error("principal inactive");
  if (capsuleId === "control-plane" && !isAdminPersona(store.personas.get(principal.personaId))) {
    throw new Error("control-plane membership requires an admin persona");
  }
  if (store.memberships.some((m) => m.principalId === principalId && m.capsuleId === capsuleId)) {
    return;
  }
  store.memberships.push({
    principalId,
    capsuleId,
    personaId: principal.personaId,
    assignmentId: `assignment.${randomUUID()}`,
  });
  store.appendAudit(actorId, "membership.add", { principalId, capsuleId, personaId: principal.personaId });
}

export function removeMembership(
  store: CcaStore,
  actorId: string,
  principalId: string,
  capsuleId: string,
): void {
  requireControlPlaneAdmin(store, actorId);
  if (!store.principals.has(principalId)) throw new Error("unknown principal");
  if (!store.capsules.has(capsuleId)) throw new Error("unknown capsule");
  const hadMembership = store.memberships.some(
    (membership) => membership.principalId === principalId && membership.capsuleId === capsuleId,
  );
  if (!hadMembership) return;
  removeMembershipUnchecked(store, actorId, principalId, capsuleId);
}

export function revokeMembershipForRecertification(
  store: CcaStore,
  input: {
    reviewerId: string;
    principalId: string;
    capsuleId: string;
    campaignId: string;
    itemId: string;
    assignmentId: string;
    reason: string;
    now?: number;
  },
): void {
  const now = input.now ?? Date.now();
  requireTime(now, "now");
  if (input.reviewerId === input.principalId) {
    throw new Error("self_review: reviewer cannot revoke their own access");
  }
  const reviewerRole = governanceReviewerRoleFor(store, input.reviewerId);
  if (!reviewerRole) throw new Error("governance reviewer required");
  const eligibleRoles = recertificationReviewerRolesFor(store, input.principalId, input.capsuleId);
  if (!eligibleRoles.includes(reviewerRole)) throw new Error("reviewer is not eligible for this membership");
  const reason = input.reason.trim();
  if (!reason) throw new Error("recertification revocation reason required");
  const membership = store.memberships.find((item) =>
    item.principalId === input.principalId && item.capsuleId === input.capsuleId
  );
  if (!membership) throw new Error("membership is no longer active");
  if (membershipAssignmentId(membership) !== input.assignmentId) {
    throw new Error("membership assignment changed after the recertification snapshot");
  }
  removeMembershipUnchecked(store, input.reviewerId, input.principalId, input.capsuleId, now, {
    campaignId: input.campaignId,
    itemId: input.itemId,
    reason,
  });
}

function removeMembershipUnchecked(
  store: CcaStore,
  actorId: string,
  principalId: string,
  capsuleId: string,
  now = Date.now(),
  recertification?: { campaignId: string; itemId: string; reason: string },
): void {
  if (
    capsuleId === "control-plane"
    && isControlPlaneAdmin(store, principalId)
    && ![...store.principals.keys()].some((candidateId) =>
      candidateId !== principalId && isControlPlaneAdmin(store, candidateId)
    )
  ) {
    throw new Error("refusing to remove the last active control-plane administrator");
  }
  store.memberships = store.memberships.filter(
    (m) => !(m.principalId === principalId && m.capsuleId === capsuleId),
  );
  const revokedJit: string[] = [];
  for (const grant of store.jit) {
    if (
      grant.principalId === principalId
      && grant.capsuleId === capsuleId
      && (grant.status === "pending" || grant.status === "approved")
    ) {
      grant.status = "expired";
      grant.expiresAt = now;
      revokedJit.push(grant.id);
    }
  }
  store.appendAudit(actorId, "membership.remove", {
    principalId,
    capsuleId,
    revokedJit,
    ...(recertification ? { recertification } : {}),
  }, now);
}

export function requestJit(
  store: CcaStore,
  input: {
    requesterId: string;
    principalId: string;
    datasetId: string;
    capsuleId: string;
    purpose: string;
    actions?: Action[];
    contractId?: string;
    justification?: string;
    requestedTtlMs?: number;
    ticket?: string;
    /** Trusted server/IdP assertion; never copy from an unverified request body. */
    trustedAuthenticationAssurance?: string;
    now?: number;
  },
): JitLike {
  const now = input.now ?? Date.now();
  requireTime(now, "now");
  if (input.requesterId !== input.principalId) {
    throw new Error("jit requester must be the target principal");
  }
  const principal = store.principals.get(input.principalId);
  if (!principal || principal.disabled) throw new Error("principal inactive");
  const dataset = store.datasets.get(input.datasetId);
  if (!dataset || dataset.controlPlane) throw new Error("unknown or ineligible dataset");
  const allowedFields = canonicalFieldPaths(dataset.allowedFields);
  if (!allowedFields) throw new Error("dataset field allowlist missing or invalid");
  const capsule = store.capsules.get(input.capsuleId);
  if (!capsule?.active) throw new Error("capsule inactive");
  const membership = store.memberships.find(
    (item) => item.principalId === principal.id && item.capsuleId === capsule.id,
  );
  if (!membership) {
    throw new Error("jit capsule membership required");
  }
  const personaId = membership.personaId ?? principal.personaId;
  const persona = store.personas.get(personaId);
  if (!persona) throw new Error("persona missing");
  const purpose = input.purpose.trim();
  if (!purpose || purpose !== capsule.purpose) throw new Error("jit purpose must match capsule purpose");
  const actions = [...new Set(input.actions ?? ["view"])] as Action[];
  const knownActions = new Set<Action>(["view", "operate"]);
  if (
    actions.length === 0
    || actions.some((action) => !knownActions.has(action) || !persona.actions.includes(action))
  ) {
    throw new Error("jit actions must be non-empty known persona actions");
  }
  const eligible = store.bindings.flatMap((binding) => {
    if (binding.capsuleId !== capsule.id) return [];
    const contract = store.contracts.get(binding.contractId);
    if (
      !contract
      || !contract.approvalRequired
      || contract.datasetId !== dataset.id
      || contract.purpose !== purpose
      || (input.contractId !== undefined && contract.id !== input.contractId)
      || !personaMatchesContract(persona, contract.allowedPersonas)
      || actions.some((action) => !contract.actions.includes(action))
    ) return [];
    return [contract];
  });
  if (eligible.length === 0) throw new Error("no eligible approval-required contract");
  if (eligible.length > 1 && input.contractId === undefined) {
    throw new Error("multiple JIT contracts are eligible; contractId is required");
  }
  const contract = eligible[0]!;
  const contractAllowedFields = canonicalFieldPaths(contract.allowFields ?? dataset.allowedFields);
  if (!contractAllowedFields) throw new Error("contract field allowlist missing or invalid");
  const scopedAllowedFields = intersectFieldPaths(allowedFields, contractAllowedFields);
  if (scopedAllowedFields.length === 0) throw new Error("jit contract releases no fields");
  if (persona.ceiling === "none") throw new Error("persona has no data classification clearance");
  const classificationMax = CLASS_RANK[persona.ceiling] <= CLASS_RANK[contract.classificationMax]
    ? persona.ceiling
    : contract.classificationMax;
  if (CLASS_RANK[dataset.classification] > CLASS_RANK[classificationMax]) {
    throw new Error("jit dataset classification exceeds the effective persona/contract ceiling");
  }
  const requestedTtlMs = input.requestedTtlMs ?? DEFAULT_JIT_TTL_MS;
  if (
    !Number.isSafeInteger(requestedTtlMs)
    || requestedTtlMs < MIN_JIT_TTL_MS
    || requestedTtlMs > MAX_JIT_TTL_MS
  ) throw new Error(`jit ttl must be an integer between ${MIN_JIT_TTL_MS} and ${MAX_JIT_TTL_MS} ms`);
  const justification = input.justification?.trim() || "unspecified core request";
  const capsuleAttrs = structuredClone(capsule.attrs);
  const predicate = structuredClone(contract.predicate);
  const denyFields = [...new Set([...contract.denyFields, ...JIT_DENY_FIELDS])].sort();
  const policyVersion = jitPolicyVersion({
    contractId: contract.id,
    datasetId: dataset.id,
    capsuleId: capsule.id,
    personaId,
    purpose,
    actions,
    allowedFields: scopedAllowedFields,
    denyFields,
    predicate,
    capsuleAttrs,
    classificationMax,
  });
  const grant = {
    id: `jit-${randomUUID()}`,
    requesterId: input.requesterId,
    principalId: input.principalId,
    datasetId: input.datasetId,
    capsuleId: input.capsuleId,
    personaId,
    contractId: contract.id,
    purpose,
    actions,
    allowedFields: scopedAllowedFields,
    denyFields,
    predicate,
    capsuleAttrs,
    classificationMax,
    policyVersion,
    requestContext: {
      justification,
      requestedTtlMs,
      ...(input.ticket?.trim() ? { ticket: input.ticket.trim() } : {}),
      ...(input.trustedAuthenticationAssurance?.trim()
        ? { authenticationAssurance: input.trustedAuthenticationAssurance.trim() }
        : {}),
    },
    status: "pending" as const,
    createdAt: now,
  };
  store.jit.push(grant);
  store.appendAudit(input.requesterId, "jit.request", {
    id: grant.id,
    principalId: grant.principalId,
    datasetId: grant.datasetId,
    capsuleId: grant.capsuleId,
    purpose: grant.purpose,
    actions: grant.actions,
    allowedFields: grant.allowedFields,
    denyFields: grant.denyFields,
    classificationMax: grant.classificationMax,
    contractId: grant.contractId,
    policyVersion: grant.policyVersion,
  }, now);
  return grant;
}

type JitLike = CcaStore["jit"][number];

export function approveJit(
  store: CcaStore,
  input: {
    jitId: string;
    approverId: string;
    ttlMs?: number;
    /** Trusted server/IdP assertion; never copy from an unverified request body. */
    trustedAuthenticationAssurance?: string;
    now?: number;
  },
): JitLike {
  const now = input.now ?? Date.now();
  requireTime(now, "now");
  const grant = store.jit.find((j) => j.id === input.jitId);
  if (!grant) throw new Error("unknown jit");
  if (grant.status !== "pending") throw new Error("jit not pending");
  if (now < grant.createdAt) throw new Error("jit approval cannot predate the request");
  if (grant.requesterId === input.approverId) {
    throw new Error("dual_control: requester cannot approve");
  }
  if (!isControlPlaneAdmin(store, input.approverId)) {
    throw new Error("dual_control: approver must be an active control-plane admin");
  }
  const principal = store.principals.get(grant.principalId);
  const capsule = store.capsules.get(grant.capsuleId);
  if (!principal || principal.disabled || !capsule?.active) throw new Error("jit relationship inactive");
  const membership = store.memberships.find(
    (item) => item.principalId === principal.id
      && item.capsuleId === capsule.id
      && (item.personaId ?? principal.personaId) === grant.personaId,
  );
  if (!membership) {
    throw new Error("jit capsule membership required");
  }
  const persona = store.personas.get(grant.personaId);
  const dataset = store.datasets.get(grant.datasetId);
  const contract = store.contracts.get(grant.contractId);
  if (
    !persona
    || !dataset
    || !contract?.approvalRequired
    || !store.bindings.some((binding) =>
      binding.capsuleId === capsule.id && binding.contractId === contract.id
    )
    || !personaMatchesContract(persona, contract.allowedPersonas)
    || grant.actions.some((action) =>
      !persona.actions.includes(action) || !contract.actions.includes(action)
    )
    || persona.ceiling === "none"
  ) throw new Error("jit approval policy is no longer eligible");
  const datasetAllowedFields = canonicalFieldPaths(dataset.allowedFields);
  const contractAllowedFields = canonicalFieldPaths(contract.allowFields ?? dataset.allowedFields);
  if (!datasetAllowedFields || !contractAllowedFields) throw new Error("jit approval field policy invalid");
  const currentAllowedFields = intersectFieldPaths(datasetAllowedFields, contractAllowedFields);
  const currentClassificationMax = CLASS_RANK[persona.ceiling] <= CLASS_RANK[contract.classificationMax]
    ? persona.ceiling
    : contract.classificationMax;
  const currentDenyFields = [...new Set([...contract.denyFields, ...JIT_DENY_FIELDS])].sort();
  const currentPolicyVersion = jitPolicyVersion({
    contractId: contract.id,
    datasetId: dataset.id,
    capsuleId: capsule.id,
    personaId: persona.id,
    purpose: contract.purpose,
    actions: grant.actions,
    allowedFields: currentAllowedFields,
    denyFields: currentDenyFields,
    predicate: contract.predicate,
    capsuleAttrs: capsule.attrs,
    classificationMax: currentClassificationMax,
  });
  if (currentPolicyVersion !== grant.policyVersion) {
    throw new Error("jit approval policy changed after request; request a new grant");
  }
  const ttlMs = input.ttlMs ?? DEFAULT_JIT_TTL_MS;
  if (
    !Number.isSafeInteger(ttlMs)
    || ttlMs < MIN_JIT_TTL_MS
    || ttlMs > MAX_JIT_TTL_MS
    || ttlMs > grant.requestContext.requestedTtlMs
    || !Number.isSafeInteger(now + ttlMs)
  ) {
    throw new Error(`jit ttl must be an integer between ${MIN_JIT_TTL_MS} and ${MAX_JIT_TTL_MS} ms`);
  }
  grant.status = "approved";
  grant.approverId = input.approverId;
  grant.expiresAt = now + ttlMs;
  grant.approvalContext = {
    approvedAt: now,
    approvedBy: input.approverId,
    ttlMs,
    ...(input.trustedAuthenticationAssurance?.trim()
      ? { authenticationAssurance: input.trustedAuthenticationAssurance.trim() }
      : {}),
  };
  store.appendAudit(input.approverId, "jit.approve", {
    id: grant.id,
    expiresAt: grant.expiresAt,
    contractId: grant.contractId,
    policyVersion: grant.policyVersion,
    approvalContext: grant.approvalContext,
  }, now);
  return grant;
}

export function denyJit(
  store: CcaStore,
  input: { jitId: string; denierId: string; reason: string; now?: number },
): JitLike {
  const now = input.now ?? Date.now();
  requireTime(now, "now");
  const grant = store.jit.find((item) => item.id === input.jitId);
  if (!grant) throw new Error("unknown jit");
  if (grant.status !== "pending") throw new Error("jit not pending");
  if (now < grant.createdAt) throw new Error("jit denial cannot predate the request");
  if (grant.requesterId === input.denierId) {
    throw new Error("dual_control: requester cannot deny their own request");
  }
  if (!isControlPlaneAdmin(store, input.denierId)) {
    throw new Error("dual_control: denier must be an active control-plane admin");
  }
  const reason = input.reason.trim();
  if (!reason) throw new Error("jit denial reason required");
  grant.status = "denied";
  grant.deniedAt = now;
  grant.deniedBy = input.denierId;
  grant.denialReason = reason;
  store.appendAudit(input.denierId, "jit.deny", {
    id: grant.id,
    principalId: grant.principalId,
    contractId: grant.contractId,
    policyVersion: grant.policyVersion,
    reason,
  }, now);
  return grant;
}

export function revokeJit(
  store: CcaStore,
  input: { jitId: string; actorId: string; reason: string; now?: number },
): JitLike {
  const now = input.now ?? Date.now();
  requireTime(now, "now");
  const grant = store.jit.find((item) => item.id === input.jitId);
  if (!grant) throw new Error("unknown jit");
  if (input.actorId !== grant.requesterId && !isControlPlaneAdmin(store, input.actorId)) {
    throw new Error("jit revoke requires the requester or a control-plane admin");
  }
  if (grant.status !== "pending" && grant.status !== "approved") {
    throw new Error("jit is not revocable");
  }
  const reason = input.reason.trim();
  if (!reason) throw new Error("jit revocation reason required");
  grant.status = "revoked";
  grant.revokedAt = now;
  grant.revokedBy = input.actorId;
  grant.revocationReason = reason;
  grant.expiresAt = Math.min(grant.expiresAt ?? now, now);
  store.appendAudit(input.actorId, "jit.revoke", {
    id: grant.id,
    principalId: grant.principalId,
    contractId: grant.contractId,
    policyVersion: grant.policyVersion,
    reason,
  }, now);
  return grant;
}

export type AppliedRole = {
  personaId: string;
  capsuleId: string;
  contractId: string;
  inherits?: string;
};

export function applyRoleDraft(
  store: CcaStore,
  input: {
    actorId: string;
    principalId: string;
    draft: RoleDraft;
  },
): AppliedRole {
  requireControlPlaneAdmin(store, input.actorId);
  const errors = validateRoleDraft(input.draft);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const target = store.principals.get(input.principalId);
  if (!target) throw new Error("unknown principal");
  if (target.disabled) throw new Error("principal inactive");
  if (isControlPlaneAdmin(store, target.id)) {
    throw new Error("control-plane administrator roles cannot be replaced or extended with warehouse access");
  }
  const sodViolations = evaluateRoleDraftSod(store, target.id, input.draft);
  if (sodViolations.length > 0) throw new SodPolicyViolationError(sodViolations);

  const actions = uniqueActions(input.draft.verbs).sort();
  const capabilityFingerprint = sha256(JSON.stringify({ actions, ceiling: input.draft.ceiling })).slice(0, 16);
  const personaId = `capability.${capabilityFingerprint}`;
  if (!store.personas.has(personaId)) {
    store.personas.set(personaId, {
      id: personaId,
      label: `Scoped ${actions.join(" + ")} (${input.draft.ceiling})`,
      actions,
      ceiling: input.draft.ceiling,
    });
  }

  const scopeAttrs = {
    tenants: [...input.draft.tenants].sort(),
    regions: [...input.draft.regions].sort(),
    departments: [...input.draft.departments].sort(),
    products: [...input.draft.products].sort(),
    sources: [...(input.draft.sources ?? [])].sort(),
  };
  const scopeFingerprint = sha256(JSON.stringify({
    purpose: input.draft.purpose,
    attrs: scopeAttrs,
  })).slice(0, 16);
  const capsuleId = `scope.${scopeFingerprint}`;
  const contractFingerprint = sha256(JSON.stringify({
    personaId,
    scopeFingerprint,
    actions,
    ceiling: input.draft.ceiling,
    denyFields: [...input.draft.denyFields].sort(),
  })).slice(0, 16);
  const contractId = `warehouse.${contractFingerprint}`;

  if (!store.capsules.has(capsuleId)) {
    store.capsules.set(capsuleId, {
      id: capsuleId,
      label: input.draft.name.trim(),
      purpose: input.draft.purpose,
      active: true,
      attrs: { ...scopeAttrs, managedBy: "role-studio" },
    });
  } else {
    const existing = store.capsules.get(capsuleId)!;
    if (existing.purpose !== input.draft.purpose) throw new Error("scope hash collision");
    existing.active = true;
  }

  if (!store.datasets.get("warehouse")) {
    store.datasets.set("warehouse", {
      id: "warehouse",
      name: "Shared operational warehouse",
      origin: "SQLite fact table",
      design: "Dimensional facts",
      classification: "restricted",
      controlPlane: false,
      allowedFields: [...WAREHOUSE_ALLOWED_FIELDS],
    });
  }

  if (!store.contracts.has(contractId)) {
    store.contracts.set(contractId, {
      id: contractId,
      datasetId: "warehouse",
      purpose: input.draft.purpose,
      allowedPersonas: [personaId],
      actions,
      classificationMax: input.draft.ceiling,
      predicate: draftToPredicate(input.draft),
      allowFields: [...WAREHOUSE_ALLOWED_FIELDS],
      denyFields: [...input.draft.denyFields].sort(),
    });
  }

  const bindingId = `bind-${capsuleId}-${contractId}`;
  if (!store.bindings.some((binding) => binding.id === bindingId)) {
    store.bindings.push({ id: bindingId, capsuleId, contractId });
  }

  const retiredCapsules = new Set(
    store.memberships
      .filter((membership) =>
        membership.principalId === target.id
        && store.capsules.get(membership.capsuleId)?.attrs.managedBy === "role-studio"
        && membership.capsuleId !== capsuleId,
      )
      .map((membership) => membership.capsuleId),
  );
  if (retiredCapsules.size > 0) {
    store.memberships = store.memberships.filter((membership) =>
      !(membership.principalId === target.id && retiredCapsules.has(membership.capsuleId)),
    );
    for (const retiredId of retiredCapsules) {
      if (!store.memberships.some((membership) => membership.capsuleId === retiredId)) {
        const retired = store.capsules.get(retiredId);
        if (retired) retired.active = false;
      }
    }
    const now = Date.now();
    for (const grant of store.jit) {
      if (
        grant.principalId === target.id
        && retiredCapsules.has(grant.capsuleId)
        && (grant.status === "pending" || grant.status === "approved")
      ) {
        grant.status = "expired";
        grant.expiresAt = now;
      }
    }
  }

  const existingMembership = store.memberships.find((membership) =>
    membership.principalId === input.principalId && membership.capsuleId === capsuleId
  );
  if (existingMembership) {
    existingMembership.personaId = personaId;
    existingMembership.assignmentId ??= `assignment.${randomUUID()}`;
  } else {
    store.memberships.push({
      principalId: input.principalId,
      capsuleId,
      personaId,
      assignmentId: `assignment.${randomUUID()}`,
    });
  }
  store.appendAudit(input.actorId, "membership.add", { principalId: input.principalId, capsuleId, personaId });
  store.appendAudit(input.actorId, "role.apply", {
    principalId: input.principalId,
    personaId,
    capsuleId,
    contractId,
    retiredCapsules: [...retiredCapsules],
    draft: input.draft,
  });
  return { personaId, capsuleId, contractId };
}

function uniqueActions(actions: Action[]): Action[] {
  return [...new Set(actions)];
}

export function warehouseScopesFor(
  store: CcaStore,
  principalId: string,
  purpose?: string,
): Array<{
  ceiling: Classification;
  allowedFields: string[];
  denyFields: string[];
  products: string[];
  tenants: string[];
  regions: string[];
  departments: string[];
  sources: string[];
  purpose: string;
  contractId: string;
  capsuleId: string;
}> {
  const principal = store.principals.get(principalId);
  const trustedPurpose = purpose?.trim();
  const warehouse = store.datasets.get("warehouse");
  const allowedFields = canonicalFieldPaths(warehouse?.allowedFields);
  if (
    !principal
    || principal.disabled
    || !trustedPurpose
    || !warehouse
    || !allowedFields
  ) {
    return [];
  }
  const memberships = store.liveMembershipsFor(principalId);
  return store.bindings.flatMap((binding) => {
    const effective = memberships.find(({ membership }) => membership.capsuleId === binding.capsuleId);
    const capsule = effective?.capsule;
    const persona = effective?.persona;
    const contract = store.contracts.get(binding.contractId);
    if (
      !capsule
      || !persona
      || !contract
      || contract.datasetId !== "warehouse"
      || !contract.actions.includes("view")
      || contract.purpose !== trustedPurpose
    ) return [];
    const contractAllowedFields = canonicalFieldPaths(contract.allowFields ?? allowedFields);
    if (!contractAllowedFields) return [];
    const effectiveAllowedFields = intersectFieldPaths(allowedFields, contractAllowedFields);
    if (effectiveAllowedFields.length === 0) return [];
    if (contract.allowedPersonas.length === 0) return [];
    const allowed =
      contract.allowedPersonas.includes(persona.id) ||
      Boolean(persona.inherits && contract.allowedPersonas.includes(persona.inherits));
    if (!allowed) return [];
    if (persona.ceiling === "none") return [];
    const ceiling = CLASS_RANK[persona.ceiling] <= CLASS_RANK[contract.classificationMax]
      ? persona.ceiling
      : contract.classificationMax;
    return predicateToWarehouseScopes(contract.predicate, capsule).flatMap((scope) => {
      if (!scope.products || scope.products.length === 0) return [];
      return [{
        ceiling,
        allowedFields: effectiveAllowedFields,
        denyFields: [...contract.denyFields],
        products: scope.products,
        tenants: scope.tenants ?? [],
        regions: scope.regions ?? [],
        departments: scope.departments ?? [],
        sources: scope.sources ?? [],
        purpose: contract.purpose,
        contractId: contract.id,
        capsuleId: capsule.id,
      }];
    });
  });
}

type WarehouseDimensions = Partial<Record<
  "products" | "tenants" | "regions" | "departments" | "sources",
  string[]
>>;

const WAREHOUSE_FIELD_TO_DIMENSION = {
  product: "products",
  tenant: "tenants",
  region: "regions",
  department: "departments",
  source: "sources",
} as const;

function predicateToWarehouseScopes(
  predicate: Predicate,
  capsule: Capsule,
): WarehouseDimensions[] {
  switch (predicate.op) {
    case "true":
      return [{}];
    case "eq":
      return dimensionScope(predicate.field, [predicate.value]);
    case "in":
      return dimensionScope(predicate.field, predicate.values);
    case "fromCapsuleAttr": {
      const values = capsule.attrs[predicate.attr];
      return Array.isArray(values) ? dimensionScope(predicate.field, values) : [];
    }
    case "or":
      return predicate.clauses.flatMap((clause) => predicateToWarehouseScopes(clause, capsule));
    case "and": {
      let combined: WarehouseDimensions[] = [{}];
      for (const clause of predicate.clauses) {
        const next = predicateToWarehouseScopes(clause, capsule);
        combined = combined.flatMap((left) =>
          next.flatMap((right) => {
            const merged = mergeDimensions(left, right);
            return merged ? [merged] : [];
          }),
        );
      }
      return combined;
    }
    default: {
      const never: never = predicate;
      return never;
    }
  }
}

function dimensionScope(field: string, rawValues: unknown[]): WarehouseDimensions[] {
  const dimension = WAREHOUSE_FIELD_TO_DIMENSION[field as keyof typeof WAREHOUSE_FIELD_TO_DIMENSION];
  if (!dimension || rawValues.length === 0 || rawValues.some((value) => typeof value !== "string")) {
    return [];
  }
  return [{ [dimension]: [...new Set(rawValues as string[])] }];
}

function mergeDimensions(
  left: WarehouseDimensions,
  right: WarehouseDimensions,
): WarehouseDimensions | undefined {
  const merged: WarehouseDimensions = {};
  for (const dimension of ["products", "tenants", "regions", "departments", "sources"] as const) {
    const leftValues = left[dimension];
    const rightValues = right[dimension];
    if (leftValues && rightValues) {
      const intersection = leftValues.filter((value) => rightValues.includes(value));
      if (intersection.length === 0) return undefined;
      merged[dimension] = [...new Set(intersection)];
    } else if (leftValues || rightValues) {
      merged[dimension] = [...(leftValues ?? rightValues)!];
    }
  }
  return merged;
}

function jitPolicyVersion(scope: {
  contractId: string;
  datasetId: string;
  capsuleId: string;
  personaId: string;
  purpose: string;
  actions: Action[];
  allowedFields: string[];
  denyFields: string[];
  predicate: Predicate;
  capsuleAttrs: Record<string, unknown>;
  classificationMax: Classification;
}): string {
  return `jit-${sha256(JSON.stringify(scope)).slice(0, 24)}`;
}
