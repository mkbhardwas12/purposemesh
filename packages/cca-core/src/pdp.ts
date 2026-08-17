import {
  canonicalFieldPaths,
  evalPredicate,
  intersectFieldPaths,
  projectAttrs,
} from "./predicate.js";
import type { CcaStore } from "./store.js";
import {
  CLASS_RANK,
  type Action,
  type Capsule,
  type CheckInput,
  type Classification,
  type Contract,
  type Decision,
  type FilteredRecord,
  type JitGrant,
  type Persona,
} from "./types.js";

function deny(reason: string): Decision {
  return { effect: "deny", reason, allowedFields: [], denyFields: [] };
}

function personaHasAction(persona: Persona, action: Action): boolean {
  return persona.actions.includes(action);
}

export function personaMatchesContract(persona: Persona, allowed: string[]): boolean {
  return allowed.length > 0
    && (allowed.includes(persona.id) || Boolean(persona.inherits && allowed.includes(persona.inherits)));
}

export function isAdminPersona(persona: Persona | undefined): boolean {
  return persona?.id === "admin";
}

function ceilingOk(persona: Persona, classification: Classification): boolean {
  if (persona.ceiling === "none") return false;
  return CLASS_RANK[classification] <= CLASS_RANK[persona.ceiling];
}

function liveJit(
  store: CcaStore,
  principalId: string,
  datasetId: string,
  action: Action,
  purpose: string,
  memberships: ReturnType<CcaStore["liveMembershipsFor"]>,
  now: number,
): JitGrant | undefined {
  return store.jit.find((grant) => {
    if (grant.requesterId !== principalId || grant.principalId !== principalId) return false;
    if (grant.datasetId !== datasetId || grant.purpose !== purpose) return false;
    if (!grant.actions.includes(action)) return false;
    if (!memberships.some(({ membership, persona }) =>
      membership.capsuleId === grant.capsuleId && persona.id === grant.personaId
    )) return false;
    if (grant.status !== "approved") return false;
    if (now < grant.createdAt) return false;
    if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt! <= now) return false;
    return true;
  });
}

type ContractCandidate = {
  capsule: Capsule;
  contract: Contract;
  persona: Persona;
};

export function check(store: CcaStore, input: CheckInput): Decision {
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) return deny("invalid_time");

  const principal = store.principals.get(input.principalId);
  if (!principal || principal.disabled) return deny("principal_inactive");

  const persona = store.personas.get(principal.personaId);
  if (!persona) return deny("persona_missing");

  const dataset = store.datasets.get(input.datasetId);
  if (!dataset) return deny("dataset_unknown");
  const datasetAllowedFields = canonicalFieldPaths(dataset.allowedFields);
  if (!datasetAllowedFields) return deny("dataset_field_allowlist_missing");
  if (input.record && input.record.datasetId !== dataset.id) return deny("record_dataset_mismatch");

  const memberships = store.liveMembershipsFor(principal.id);
  if (memberships.length === 0) return deny("no_capsule_membership");
  if (!memberships.some(({ persona: assignedPersona }) => personaHasAction(assignedPersona, input.action))) {
    return deny("persona_lacks_verb");
  }
  const capsules = memberships.map(({ capsule }) => capsule);
  const purpose = input.purpose?.trim();
  if (!purpose) return deny("purpose_required");

  if (dataset.controlPlane) {
    if (purpose !== "governance") return deny("purpose_mismatch");
    if (input.action !== "audit" && input.action !== "administer" && input.action !== "rotate") {
      return deny("control_plane_verb_required");
    }
    const control = capsules.find((capsule) => capsule.id === "control-plane");
    if (!control) return deny("control_plane_capsule_required");
    if (!isAdminPersona(persona)) return deny("control_plane_admin_required");
    return {
      effect: "allow",
      reason: "control_plane_persona",
      capsuleId: control.id,
      capsuleIds: [control.id],
      allowedFields: datasetAllowedFields,
      denyFields: [],
    };
  }

  const candidates: ContractCandidate[] = store.bindings.flatMap((binding) => {
    const contract = store.contracts.get(binding.contractId);
    if (!contract || contract.approvalRequired || contract.datasetId !== dataset.id) return [];
    return memberships.flatMap(({ membership, capsule, persona: assignedPersona }) => {
      if (membership.capsuleId !== binding.capsuleId) return [];
      if (!personaMatchesContract(assignedPersona, contract.allowedPersonas)) return [];
      if (!personaHasAction(assignedPersona, input.action) || !contract.actions.includes(input.action)) return [];
      return [{ capsule, contract, persona: assignedPersona }];
    });
  });

  // A caller-supplied record can make a row more sensitive, never less
  // sensitive than its registered dataset. API adapters resolve records from
  // server state, but the core invariant also protects direct SDK callers.
  const actualClassification = input.record
    && CLASS_RANK[input.record.classification] > CLASS_RANK[dataset.classification]
    ? input.record.classification
    : dataset.classification;
  const allowed: ContractCandidate[] = [];
  let sawPurposeMismatch = false;
  let sawContractClassificationLimit = false;
  let sawPersonaClassificationLimit = false;
  let sawPredicateMiss = false;
  let sawRecordRequired = false;

  for (const candidate of candidates) {
    const { contract, capsule, persona: assignedPersona } = candidate;
    if (purpose !== contract.purpose) {
      sawPurposeMismatch = true;
      continue;
    }
    if (CLASS_RANK[actualClassification] > CLASS_RANK[contract.classificationMax]) {
      sawContractClassificationLimit = true;
      continue;
    }
    if (!ceilingOk(assignedPersona, actualClassification)) {
      sawPersonaClassificationLimit = true;
      continue;
    }
    if (!input.record && contract.predicate.op !== "true") {
      sawRecordRequired = true;
      continue;
    }
    if (input.record && !evalPredicate(contract.predicate, input.record.attrs, capsule)) {
      sawPredicateMiss = true;
      continue;
    }
    allowed.push(candidate);
  }

  if (allowed.length > 0) {
    allowed.sort((left, right) =>
      `${left.contract.id}\u0000${left.capsule.id}`.localeCompare(
        `${right.contract.id}\u0000${right.capsule.id}`,
      ),
    );
    const contractIds = [...new Set(allowed.map(({ contract }) => contract.id))];
    const capsuleIds = [...new Set(allowed.map(({ capsule }) => capsule.id))];
    const denyFields = [...new Set(allowed.flatMap(({ contract }) => contract.denyFields))].sort();
    const allowedFields = [...new Set(allowed.flatMap(({ contract }) =>
      intersectFieldPaths(datasetAllowedFields, canonicalFieldPaths(contract.allowFields ?? datasetAllowedFields) ?? [])
    ))].sort();
    if (allowedFields.length === 0) return deny("contract_field_allowlist_empty");
    return {
      effect: "allow",
      reason: "contract_allow",
      contractId: contractIds[0],
      capsuleId: capsuleIds[0],
      contractIds,
      capsuleIds,
      allowedFields,
      denyFields,
    };
  }

  const jit = liveJit(store, principal.id, dataset.id, input.action, purpose, memberships, now);
  if (jit) {
    const jitPersona = store.personas.get(jit.personaId);
    if (!jitPersona || !personaHasAction(jitPersona, input.action)) return deny("jit_persona_inactive");
    if (CLASS_RANK[actualClassification] > CLASS_RANK[jit.classificationMax]) {
      return deny("jit_classification_limit");
    }
    if (!ceilingOk(jitPersona, actualClassification)) return deny("classification_ceiling");
    if (!input.record && jit.predicate.op !== "true") return deny("record_required");
    const frozenCapsule: Capsule = {
      id: jit.capsuleId,
      label: "JIT scope snapshot",
      purpose: jit.purpose,
      active: true,
      attrs: structuredClone(jit.capsuleAttrs),
    };
    if (input.record && !evalPredicate(jit.predicate, input.record.attrs, frozenCapsule)) {
      return deny("jit_predicate_miss");
    }
    const jitAllowedFields = intersectFieldPaths(datasetAllowedFields, jit.allowedFields);
    if (jitAllowedFields.length === 0) return deny("jit_field_allowlist_empty");
    return {
      effect: "allow",
      reason: "jit_allow",
      capsuleId: jit.capsuleId,
      capsuleIds: [jit.capsuleId],
      allowedFields: jitAllowedFields,
      denyFields: [...jit.denyFields],
      jitId: jit.id,
    };
  }

  if (candidates.length === 0) return deny("no_contract_binding");
  if (sawRecordRequired) return deny("record_required");
  if (sawContractClassificationLimit) return deny("contract_classification_limit");
  if (sawPersonaClassificationLimit) return deny("classification_ceiling");
  if (sawPredicateMiss) return deny("predicate_miss");
  if (sawPurposeMismatch) return deny("purpose_mismatch");
  return deny("no_contract_binding");
}

export function filterDataset(
  store: CcaStore,
  principalId: string,
  datasetId: string,
  purpose?: string,
  now?: number,
): { decision: Decision; records: FilteredRecord[] } {
  const probe = check(store, {
    principalId,
    action: "view",
    datasetId,
    purpose,
    now,
  });

  const records: FilteredRecord[] = [];
  let lastDeny: Decision = probe;
  let lastAllow: Decision | undefined;

  for (const record of store.records.filter((item) => item.datasetId === datasetId)) {
    const decision = check(store, {
      principalId,
      action: "view",
      datasetId,
      record,
      purpose,
      now,
    });
    if (decision.effect === "deny") {
      lastDeny = decision;
      continue;
    }
    lastAllow = decision;
    records.push({
      id: record.id,
      datasetId: record.datasetId,
      classification: record.classification,
      attrs: projectAttrs(record.attrs, {
        allowedFields: decision.allowedFields,
        denyFields: decision.denyFields,
      }),
      contractId: decision.contractId ?? "jit",
      capsuleId: decision.capsuleId ?? "",
    });
  }

  if (records.length === 0) return { decision: lastDeny, records: [] };
  return { decision: lastAllow ?? probe, records };
}

export function explainAccess(
  store: CcaStore,
  principalId: string,
  now?: number,
  trustedPurpose?: string,
): Array<{
  datasetId: string;
  datasetName: string;
  effect: Decision["effect"];
  reason: string;
  rowCount: number;
  contractId?: string;
}> {
  const purposeFilter = trustedPurpose === undefined ? undefined : trustedPurpose.trim();
  const capsuleIds = new Set(store.liveCapsulesFor(principalId).map((capsule) => capsule.id));
  return [...store.datasets.values()]
    .filter((dataset) => !dataset.controlPlane && dataset.id !== "warehouse")
    .map((dataset) => {
      const purposes = new Set<string>();
      for (const binding of store.bindings) {
        if (!capsuleIds.has(binding.capsuleId)) continue;
        const contract = store.contracts.get(binding.contractId);
        if (
          contract?.datasetId === dataset.id
          && (purposeFilter === undefined || contract.purpose === purposeFilter)
        ) purposes.add(contract.purpose);
      }
      for (const grant of store.jit) {
        if (
          grant.principalId === principalId
          && grant.datasetId === dataset.id
          && (purposeFilter === undefined || grant.purpose === purposeFilter)
        ) purposes.add(grant.purpose);
      }

      const attempts = [...purposes].map((purpose) =>
        filterDataset(store, principalId, dataset.id, purpose, now),
      );
      const best = attempts.sort((left, right) => right.records.length - left.records.length)[0]
        ?? filterDataset(store, principalId, dataset.id, purposeFilter, now);
      return {
        datasetId: dataset.id,
        datasetName: dataset.name,
        effect: best.records.length > 0 ? "allow" : best.decision.effect,
        reason: best.decision.reason,
        rowCount: best.records.length,
        contractId: best.decision.contractId,
      };
    });
}
