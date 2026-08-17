import { sha256 } from "./crypto.js";
import {
  CLASS_RANK,
  type Action,
  type AuditEvent,
  type Binding,
  type Capsule,
  type Classification,
  type Contract,
  type Dataset,
  type JitGrant,
  type Membership,
  type Persona,
  type Predicate,
  type Principal,
  type RecordRow,
} from "./types.js";

export type CcaStoreSnapshot = {
  version: 3;
  seq: number;
  personas: Persona[];
  capsules: Capsule[];
  principals: Principal[];
  memberships: Membership[];
  datasets: Dataset[];
  contracts: Contract[];
  bindings: Binding[];
  records: RecordRow[];
  jit: JitGrant[];
  audit: AuditEvent[];
};

const ACTIONS = new Set<Action>(["view", "operate", "rotate", "administer", "audit"]);
const CLASSIFICATIONS = new Set<Classification>(Object.keys(CLASS_RANK) as Classification[]);
const JIT_STATUSES = new Set<JitGrant["status"]>(["pending", "approved", "denied", "expired", "revoked"]);

export class CcaStore {
  personas = new Map<string, Persona>();
  capsules = new Map<string, Capsule>();
  principals = new Map<string, Principal>();
  memberships: Membership[] = [];
  datasets = new Map<string, Dataset>();
  contracts = new Map<string, Contract>();
  bindings: Binding[] = [];
  records: RecordRow[] = [];
  jit: JitGrant[] = [];
  private auditEvents: AuditEvent[] = [];
  private seq = 0;

  get audit(): readonly AuditEvent[] {
    return [...this.auditEvents];
  }

  clone(): CcaStore {
    return CcaStore.fromSnapshot(this.snapshot());
  }

  snapshot(): CcaStoreSnapshot {
    const snapshot: CcaStoreSnapshot = {
      version: 3,
      seq: this.seq,
      personas: [...this.personas.values()],
      capsules: [...this.capsules.values()],
      principals: [...this.principals.values()],
      memberships: this.memberships,
      datasets: [...this.datasets.values()],
      contracts: [...this.contracts.values()],
      bindings: this.bindings,
      records: this.records,
      jit: this.jit,
      audit: this.auditEvents,
    };
    assertJsonValue(snapshot, "store snapshot");
    return structuredClone(snapshot);
  }

  static fromSnapshot(snapshot: CcaStoreSnapshot | unknown): CcaStore {
    const store = new CcaStore();
    store.restore(snapshot);
    return store;
  }

  restore(snapshot: CcaStoreSnapshot | unknown): void {
    assertJsonValue(snapshot, "store snapshot");
    const next = structuredClone(snapshot);
    assertSnapshot(next);

    this.personas = new Map(next.personas.map((persona) => [persona.id, persona]));
    this.capsules = new Map(next.capsules.map((capsule) => [capsule.id, capsule]));
    this.principals = new Map(next.principals.map((principal) => [principal.id, principal]));
    this.memberships = next.memberships;
    this.datasets = new Map(next.datasets.map((dataset) => [dataset.id, dataset]));
    this.contracts = new Map(next.contracts.map((contract) => [contract.id, contract]));
    this.bindings = next.bindings;
    this.records = next.records;
    this.jit = next.jit;
    this.auditEvents = next.audit.map((event) => deepFreeze(event));
    this.seq = next.seq;

    assertStoreRelationships(this);
    if (!this.verifyAuditChain()) throw new Error("invalid store snapshot: audit chain mismatch");
  }

  appendAudit(
    actorId: string,
    type: string,
    detail: Record<string, unknown>,
    at = Date.now(),
  ): AuditEvent {
    if (!actorId.trim() || !type.trim()) throw new Error("audit actor and type are required");
    if (!Number.isSafeInteger(at) || at < 0) throw new Error("audit time must be a non-negative integer");
    assertJsonValue(detail, "audit detail");
    const immutableDetail = structuredClone(detail);
    const prevHash = this.auditEvents.at(-1)?.hash ?? "genesis";
    const seq = this.seq + 1;
    const payload = JSON.stringify({ seq, at, actorId, type, detail: immutableDetail, prevHash });
    const event: AuditEvent = deepFreeze({
      seq,
      at,
      actorId,
      type,
      detail: immutableDetail,
      prevHash,
      hash: sha256(payload),
    });
    this.seq = seq;
    this.auditEvents.push(event);
    return event;
  }

  verifyAuditChain(): boolean {
    let prevHash = "genesis";
    for (let index = 0; index < this.auditEvents.length; index += 1) {
      const event = this.auditEvents[index]!;
      const expectedSeq = index + 1;
      if (event.seq !== expectedSeq || event.prevHash !== prevHash) return false;
      const payload = JSON.stringify({
        seq: event.seq,
        at: event.at,
        actorId: event.actorId,
        type: event.type,
        detail: event.detail,
        prevHash: event.prevHash,
      });
      if (sha256(payload) !== event.hash) return false;
      prevHash = event.hash;
    }
    return this.seq === this.auditEvents.length;
  }

  liveCapsulesFor(principalId: string): Capsule[] {
    const seen = new Set<string>();
    return this.memberships.flatMap((membership) => {
      if (membership.principalId !== principalId || seen.has(membership.capsuleId)) return [];
      const capsule = this.capsules.get(membership.capsuleId);
      if (!capsule?.active) return [];
      seen.add(capsule.id);
      return [capsule];
    });
  }

  liveMembershipsFor(principalId: string): Array<{
    membership: Membership;
    capsule: Capsule;
    persona: Persona;
  }> {
    return this.memberships.flatMap((membership) => {
      if (membership.principalId !== principalId) return [];
      const principal = this.principals.get(principalId);
      const capsule = this.capsules.get(membership.capsuleId);
      const persona = this.personas.get(membership.personaId ?? principal?.personaId ?? "");
      if (!principal || principal.disabled || !capsule?.active || !persona) return [];
      return [{ membership, capsule, persona }];
    });
  }

  descendants(capsuleId: string): string[] {
    if (!this.capsules.has(capsuleId)) return [];
    const result: string[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`capsule hierarchy cycle at ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      visited.add(id);
      result.push(id);
      for (const capsule of this.capsules.values()) {
        if (capsule.parentId === id) visit(capsule.id);
      }
      visiting.delete(id);
    };

    visit(capsuleId);
    return result;
  }
}

function assertSnapshot(value: unknown): asserts value is CcaStoreSnapshot {
  const object = asObject(value, "store snapshot");
  if (object.version !== 3) throw new Error("invalid store snapshot: unsupported version");
  requireNonNegativeInteger(object.seq, "snapshot seq");
  for (const key of [
    "personas",
    "capsules",
    "principals",
    "memberships",
    "datasets",
    "contracts",
    "bindings",
    "records",
    "jit",
    "audit",
  ] as const) {
    if (!Array.isArray(object[key])) throw new Error(`invalid store snapshot: ${key} must be an array`);
  }

  const personas = object.personas as unknown[];
  const capsules = object.capsules as unknown[];
  const principals = object.principals as unknown[];
  const memberships = object.memberships as unknown[];
  const datasets = object.datasets as unknown[];
  const contracts = object.contracts as unknown[];
  const bindings = object.bindings as unknown[];
  const records = object.records as unknown[];
  const jit = object.jit as unknown[];
  const audit = object.audit as unknown[];
  personas.forEach(assertPersona);
  capsules.forEach(assertCapsule);
  principals.forEach(assertPrincipal);
  memberships.forEach(assertMembership);
  datasets.forEach(assertDataset);
  contracts.forEach(assertContract);
  bindings.forEach(assertBinding);
  records.forEach(assertRecord);
  jit.forEach(assertJit);
  audit.forEach(assertAuditEvent);
  assertUnique((personas as Persona[]).map((item) => item.id), "persona id");
  assertUnique((capsules as Capsule[]).map((item) => item.id), "capsule id");
  assertUnique((principals as Principal[]).map((item) => item.id), "principal id");
  assertUnique((datasets as Dataset[]).map((item) => item.id), "dataset id");
  assertUnique((contracts as Contract[]).map((item) => item.id), "contract id");
  assertUnique((bindings as Binding[]).map((item) => item.id), "binding id");
  assertUnique((records as RecordRow[]).map((item) => item.id), "record id");
  assertUnique((jit as JitGrant[]).map((item) => item.id), "jit id");
}

function assertStoreRelationships(store: CcaStore): void {
  assertUnique([...store.personas.keys()], "persona id");
  assertUnique([...store.capsules.keys()], "capsule id");
  assertUnique([...store.principals.keys()], "principal id");
  assertUnique([...store.datasets.keys()], "dataset id");
  assertUnique([...store.contracts.keys()], "contract id");
  assertUnique(store.bindings.map((binding) => binding.id), "binding id");
  assertUnique(store.records.map((record) => record.id), "record id");
  assertUnique(store.jit.map((grant) => grant.id), "jit id");
  assertUnique(
    store.memberships.map((membership) => `${membership.principalId}\u0000${membership.capsuleId}`),
    "membership",
  );
  assertUnique(
    store.memberships.flatMap((membership) => membership.assignmentId ? [membership.assignmentId] : []),
    "membership assignment id",
  );

  for (const principal of store.principals.values()) {
    if (!store.personas.has(principal.personaId)) {
      throw new Error(`invalid store snapshot: principal ${principal.id} references unknown persona`);
    }
  }
  for (const persona of store.personas.values()) {
    if (persona.inherits && !store.personas.has(persona.inherits)) {
      throw new Error(`invalid store snapshot: persona ${persona.id} inherits an unknown persona`);
    }
  }
  for (const capsule of store.capsules.values()) {
    if (capsule.parentId && !store.capsules.has(capsule.parentId)) {
      throw new Error(`invalid store snapshot: capsule ${capsule.id} references unknown parent`);
    }
  }
  for (const membership of store.memberships) {
    if (!store.principals.has(membership.principalId) || !store.capsules.has(membership.capsuleId)) {
      throw new Error("invalid store snapshot: membership has an unknown principal or capsule");
    }
    if (membership.personaId !== undefined && !store.personas.has(membership.personaId)) {
      throw new Error("invalid store snapshot: membership references an unknown persona");
    }
    if (membership.capsuleId === "control-plane") {
      const principal = store.principals.get(membership.principalId)!;
      const persona = store.personas.get(membership.personaId ?? principal.personaId)!;
      if (persona.id !== "admin") {
        throw new Error("invalid store snapshot: control-plane membership requires an admin persona");
      }
    }
  }
  for (const dataset of store.datasets.values()) {
    for (const ownerId of dataset.ownerPrincipalIds ?? []) {
      const owner = store.principals.get(ownerId);
      if (!owner || owner.kind !== "human") {
        throw new Error(`invalid store snapshot: dataset ${dataset.id} references an invalid owner principal`);
      }
    }
  }
  for (const contract of store.contracts.values()) {
    if (!store.datasets.has(contract.datasetId)) {
      throw new Error(`invalid store snapshot: contract ${contract.id} references unknown dataset`);
    }
    for (const personaId of contract.allowedPersonas) {
      if (!store.personas.has(personaId)) {
        throw new Error(`invalid store snapshot: contract ${contract.id} references unknown persona`);
      }
    }
  }
  for (const binding of store.bindings) {
    if (!store.capsules.has(binding.capsuleId) || !store.contracts.has(binding.contractId)) {
      throw new Error(`invalid store snapshot: binding ${binding.id} has an unknown reference`);
    }
  }
  for (const record of store.records) {
    const dataset = store.datasets.get(record.datasetId);
    if (!dataset) {
      throw new Error(`invalid store snapshot: record ${record.id} references unknown dataset`);
    }
    if (CLASS_RANK[record.classification] > CLASS_RANK[dataset.classification]) {
      throw new Error(`invalid store snapshot: record ${record.id} exceeds its dataset classification`);
    }
    for (const field of dataset.allowedFields) {
      const values = valuesAtFieldPath(record.attrs, field.split("."));
      if (values.some((value) =>
        value !== null
        && typeof value === "object"
        && (!Array.isArray(value) || value.some((item) => item !== null && typeof item === "object"))
      )) {
        throw new Error(`invalid store snapshot: dataset ${dataset.id} allowlist path ${field} is not a leaf`);
      }
    }
  }
  for (const grant of store.jit) {
    if (
      !store.principals.has(grant.requesterId)
      || !store.principals.has(grant.principalId)
      || !store.datasets.has(grant.datasetId)
      || !store.capsules.has(grant.capsuleId)
      || !store.personas.has(grant.personaId)
      || !store.contracts.has(grant.contractId)
      || (grant.approverId !== undefined && !store.principals.has(grant.approverId))
      || (grant.revokedBy !== undefined && !store.principals.has(grant.revokedBy))
    ) {
      throw new Error(`invalid store snapshot: jit ${grant.id} has an unknown reference`);
    }
    if (grant.requesterId !== grant.principalId) {
      throw new Error(`invalid store snapshot: jit ${grant.id} requester/target mismatch`);
    }
    const principal = store.principals.get(grant.principalId)!;
    const persona = store.personas.get(grant.personaId);
    const capsule = store.capsules.get(grant.capsuleId)!;
    const contract = store.contracts.get(grant.contractId);
    if (
      !persona
      || !contract
      || grant.purpose !== capsule.purpose
      || grant.actions.some((action) => !persona.actions.includes(action))
      || contract.datasetId !== grant.datasetId
      || contract.purpose !== grant.purpose
      || !contract.approvalRequired
      || CLASS_RANK[grant.classificationMax] > CLASS_RANK[contract.classificationMax]
      || persona.ceiling === "none"
      || CLASS_RANK[grant.classificationMax] > CLASS_RANK[persona.ceiling]
    ) {
      throw new Error(`invalid store snapshot: jit ${grant.id} has invalid scope`);
    }
    if (grant.status === "pending" || grant.status === "approved") {
      if (principal.disabled || !capsule.active || !store.memberships.some((membership) =>
        membership.principalId === principal.id
        && membership.capsuleId === capsule.id
        && (membership.personaId ?? principal.personaId) === grant.personaId
      ) || !store.bindings.some((binding) =>
        binding.capsuleId === capsule.id && binding.contractId === contract.id
      )) {
        throw new Error(`invalid store snapshot: live jit ${grant.id} has an inactive relationship`);
      }
    }
    if (
      grant.status === "approved"
      && (
        grant.expiresAt === undefined
        || grant.expiresAt <= grant.createdAt
      )
    ) {
      throw new Error(`invalid store snapshot: jit ${grant.id} has an invalid expiry`);
    }
  }

  for (const capsule of store.capsules.values()) store.descendants(capsule.id);
}

function assertPersona(value: unknown, index: number): asserts value is Persona {
  const object = asObject(value, `persona ${index}`);
  requireString(object.id, "persona id");
  requireString(object.label, "persona label");
  requireActionArray(object.actions, "persona actions");
  if (object.ceiling !== "none" && !CLASSIFICATIONS.has(object.ceiling as Classification)) {
    throw new Error("invalid store snapshot: invalid persona ceiling");
  }
  if (object.inherits !== undefined) requireString(object.inherits, "persona inheritance");
}

function assertCapsule(value: unknown, index: number): asserts value is Capsule {
  const object = asObject(value, `capsule ${index}`);
  requireString(object.id, "capsule id");
  requireString(object.label, "capsule label");
  requireString(object.purpose, "capsule purpose");
  if (object.parentId !== undefined) requireString(object.parentId, "capsule parent");
  if (typeof object.active !== "boolean") throw new Error("invalid store snapshot: capsule active must be boolean");
  asObject(object.attrs, "capsule attrs");
}

function assertPrincipal(value: unknown, index: number): asserts value is Principal {
  const object = asObject(value, `principal ${index}`);
  requireString(object.id, "principal id");
  requireString(object.displayName, "principal display name");
  requireString(object.username, "principal username");
  requireString(object.passwordHash, "principal password hash");
  requireString(object.personaId, "principal persona");
  if (object.kind !== "human" && object.kind !== "workload") {
    throw new Error("invalid store snapshot: invalid principal kind");
  }
  if (typeof object.disabled !== "boolean") {
    throw new Error("invalid store snapshot: principal disabled must be boolean");
  }
}

function assertMembership(value: unknown, index: number): asserts value is Membership {
  const object = asObject(value, `membership ${index}`);
  requireString(object.principalId, "membership principal");
  requireString(object.capsuleId, "membership capsule");
  if (object.personaId !== undefined) requireString(object.personaId, "membership persona");
  if (object.assignmentId !== undefined) requireString(object.assignmentId, "membership assignment id");
}

function assertDataset(value: unknown, index: number): asserts value is Dataset {
  const object = asObject(value, `dataset ${index}`);
  requireString(object.id, "dataset id");
  requireString(object.name, "dataset name");
  requireString(object.origin, "dataset origin");
  requireString(object.design, "dataset design");
  requireClassification(object.classification, "dataset classification");
  requireFieldPathArray(object.allowedFields, "dataset allowed fields");
  if (object.ownerPrincipalIds !== undefined) {
    requireStringArray(object.ownerPrincipalIds, "dataset owner principals");
    const owners = object.ownerPrincipalIds as string[];
    if (owners.length === 0 || owners.some((owner) => !owner.trim()) || new Set(owners).size !== owners.length) {
      throw new Error("invalid store snapshot: dataset owner principals must be unique non-empty ids");
    }
  }
  if (typeof object.controlPlane !== "boolean") {
    throw new Error("invalid store snapshot: dataset controlPlane must be boolean");
  }
}

function assertContract(value: unknown, index: number): asserts value is Contract {
  const object = asObject(value, `contract ${index}`);
  requireString(object.id, "contract id");
  requireString(object.datasetId, "contract dataset");
  requireString(object.purpose, "contract purpose");
  requireStringArray(object.allowedPersonas, "contract personas");
  if ((object.allowedPersonas as string[]).length === 0) {
    throw new Error("invalid store snapshot: contract personas must not be empty");
  }
  requireActionArray(object.actions, "contract actions");
  requireClassification(object.classificationMax, "contract classification");
  assertPredicate(object.predicate, "contract predicate");
  if (object.allowFields !== undefined) requireFieldPathArray(object.allowFields, "contract allowed fields");
  requireFieldPathArray(object.denyFields, "contract deny fields");
  if (object.approvalRequired !== undefined && typeof object.approvalRequired !== "boolean") {
    throw new Error("invalid store snapshot: contract approvalRequired must be boolean");
  }
}

function assertBinding(value: unknown, index: number): asserts value is Binding {
  const object = asObject(value, `binding ${index}`);
  requireString(object.id, "binding id");
  requireString(object.capsuleId, "binding capsule");
  requireString(object.contractId, "binding contract");
}

function assertRecord(value: unknown, index: number): asserts value is RecordRow {
  const object = asObject(value, `record ${index}`);
  requireString(object.id, "record id");
  requireString(object.datasetId, "record dataset");
  requireClassification(object.classification, "record classification");
  asObject(object.attrs, "record attrs");
}

function assertJit(value: unknown, index: number): asserts value is JitGrant {
  const object = asObject(value, `jit ${index}`);
  for (const field of ["id", "requesterId", "principalId", "datasetId", "capsuleId", "purpose"] as const) {
    requireString(object[field], `jit ${field}`);
  }
  if (object.approverId !== undefined) requireString(object.approverId, "jit approver");
  requireActionArray(object.actions, "jit actions");
  requireFieldPathArray(object.allowedFields, "jit allowed fields");
  requireFieldPathArray(object.denyFields, "jit deny fields");
  requireString(object.personaId, "jit persona");
  requireString(object.contractId, "jit contract");
  requireClassification(object.classificationMax, "jit classification");
  requireString(object.policyVersion, "jit policy version");
  assertPredicate(object.predicate, "jit predicate");
  asObject(object.capsuleAttrs, "jit capsule attrs");
  const requestContext = asObject(object.requestContext, "jit request context");
  requireString(requestContext.justification, "jit justification");
  requireNonNegativeInteger(requestContext.requestedTtlMs, "jit requested ttl");
  if (requestContext.requestedTtlMs === 0) {
    throw new Error("invalid store snapshot: jit requested ttl must be positive");
  }
  if (requestContext.ticket !== undefined) requireString(requestContext.ticket, "jit ticket");
  if (requestContext.authenticationAssurance !== undefined) {
    requireString(requestContext.authenticationAssurance, "jit request authentication assurance");
  }
  if (object.approvalContext !== undefined) {
    const approval = asObject(object.approvalContext, "jit approval context");
    requireNonNegativeInteger(approval.approvedAt, "jit approved at");
    requireString(approval.approvedBy, "jit approved by");
    requireNonNegativeInteger(approval.ttlMs, "jit approved ttl");
    if (approval.authenticationAssurance !== undefined) {
      requireString(approval.authenticationAssurance, "jit approval authentication assurance");
    }
  }
  if (!JIT_STATUSES.has(object.status as JitGrant["status"])) {
    throw new Error("invalid store snapshot: invalid jit status");
  }
  requireNonNegativeInteger(object.createdAt, "jit createdAt");
  if (object.expiresAt !== undefined) requireNonNegativeInteger(object.expiresAt, "jit expiresAt");
  if (object.revokedAt !== undefined) requireNonNegativeInteger(object.revokedAt, "jit revokedAt");
  if (object.revokedBy !== undefined) requireString(object.revokedBy, "jit revokedBy");
  if (object.revocationReason !== undefined) requireString(object.revocationReason, "jit revocation reason");
  if (object.deniedAt !== undefined) requireNonNegativeInteger(object.deniedAt, "jit deniedAt");
  if (object.deniedBy !== undefined) requireString(object.deniedBy, "jit deniedBy");
  if (object.denialReason !== undefined) requireString(object.denialReason, "jit denial reason");
  if (object.status === "approved" && object.expiresAt === undefined) {
    throw new Error("invalid store snapshot: approved jit must expire");
  }
  if (object.status === "approved" && object.approvalContext === undefined) {
    throw new Error("invalid store snapshot: approved jit requires approval context");
  }
  if (object.status === "revoked" && (
    object.revokedAt === undefined || object.revokedBy === undefined || object.revocationReason === undefined
  )) {
    throw new Error("invalid store snapshot: revoked jit requires revocation evidence");
  }
  if (object.status === "denied" && (
    object.deniedAt === undefined || object.deniedBy === undefined || object.denialReason === undefined
  )) {
    throw new Error("invalid store snapshot: denied jit requires denial evidence");
  }
}

function assertAuditEvent(value: unknown, index: number): asserts value is AuditEvent {
  const object = asObject(value, `audit event ${index}`);
  requireNonNegativeInteger(object.seq, "audit seq");
  requireNonNegativeInteger(object.at, "audit time");
  requireString(object.actorId, "audit actor");
  requireString(object.type, "audit type");
  asObject(object.detail, "audit detail");
  requireString(object.prevHash, "audit prevHash");
  requireString(object.hash, "audit hash");
}

function assertPredicate(value: unknown, label: string, seen = new Set<object>()): asserts value is Predicate {
  const object = asObject(value, label);
  if (seen.has(object)) throw new Error("invalid store snapshot: cyclic predicate");
  seen.add(object);
  switch (object.op) {
    case "true":
      break;
    case "eq":
      requireString(object.field, "predicate field");
      break;
    case "in":
      requireString(object.field, "predicate field");
      if (!Array.isArray(object.values)) throw new Error("invalid store snapshot: predicate values must be an array");
      break;
    case "fromCapsuleAttr":
      requireString(object.field, "predicate field");
      requireString(object.attr, "predicate attr");
      break;
    case "and":
    case "or":
      if (!Array.isArray(object.clauses)) throw new Error("invalid store snapshot: predicate clauses must be an array");
      object.clauses.forEach((clause) => assertPredicate(clause, "predicate clause", seen));
      break;
    default:
      throw new Error("invalid store snapshot: unknown predicate operator");
  }
  seen.delete(object);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid store snapshot: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid store snapshot: ${label} must be a non-empty string`);
  }
}

function requireStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`invalid store snapshot: ${label} must be a string array`);
  }
}

function requireFieldPathArray(value: unknown, label: string): asserts value is string[] {
  requireStringArray(value, label);
  const fields = value as string[];
  for (const field of fields) {
    const path = field.split(".");
    if (
      !field
      || field.trim() !== field
      || path.some((part) =>
        !part
        || part === "__proto__"
        || part === "prototype"
        || part === "constructor"
      )
    ) {
      throw new Error(`invalid store snapshot: ${label} contains an invalid path`);
    }
  }
  if (new Set(fields).size !== fields.length) {
    throw new Error(`invalid store snapshot: ${label} contains duplicate paths`);
  }
  const ordered = [...fields].sort();
  for (let index = 0; index < ordered.length - 1; index += 1) {
    if (ordered[index + 1]!.startsWith(`${ordered[index]}.`)) {
      throw new Error(`invalid store snapshot: ${label} contains overlapping paths`);
    }
  }
}

function valuesAtFieldPath(value: unknown, path: string[]): unknown[] {
  if (path.length === 0) return [value];
  if (Array.isArray(value)) return value.flatMap((item) => valuesAtFieldPath(item, path));
  if (value === null || typeof value !== "object") return [];
  const [head, ...rest] = path;
  if (!head || !Object.hasOwn(value, head)) return [];
  return valuesAtFieldPath((value as Record<string, unknown>)[head], rest);
}

function requireActionArray(value: unknown, label: string): asserts value is Action[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !ACTIONS.has(item as Action))) {
    throw new Error(`invalid store snapshot: ${label} must contain known actions`);
  }
}

function requireClassification(value: unknown, label: string): asserts value is Classification {
  if (!CLASSIFICATIONS.has(value as Classification)) {
    throw new Error(`invalid store snapshot: ${label} is invalid`);
  }
}

function requireNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`invalid store snapshot: ${label} must be a non-negative integer`);
  }
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`invalid store snapshot: duplicate ${label}`);
}

function assertJsonValue(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${label} is not JSON-serializable`);
  if (seen.has(value)) throw new Error(`${label} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => assertJsonValue(item, label, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} contains a non-plain object`);
    }
    for (const item of Object.values(value as Record<string, unknown>)) {
      if (item === undefined) throw new Error(`${label} contains undefined`);
      assertJsonValue(item, label, seen);
    }
  }
  seen.delete(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
