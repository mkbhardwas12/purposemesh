import type { CcaStore } from "./store.js";
import { canonicalFieldPaths, evalPredicate, intersectFieldPaths } from "./predicate.js";
import { sha256 } from "./crypto.js";
import { CLASS_RANK } from "./types.js";
import { personaMatchesContract } from "./pdp.js";
import type { Action, Capsule, Contract, Dataset, Predicate } from "./types.js";

export type EnforcementCapability =
  | "classification_ceiling"
  | "row_filter"
  | "field_allowlist"
  | "field_denylist"
  | "purpose_binding"
  | "workload_identity";

export type CapabilityGate = {
  target: "elasticsearch" | "bw" | "bobj" | "dashboard" | "adf";
  contractId: string;
  datasetId: string;
  required: EnforcementCapability[];
  supported: EnforcementCapability[];
  missing: EnforcementCapability[];
  status: "eligible" | "blocked";
  reason?: string;
};

export type CompiledPolicy = {
  capsuleId: string;
  policyVersion: string;
  policyHash: string;
  deploymentStatus: "deployable" | "blocked";
  /** True means native-shaped artifacts are previews only and the apply plan is intentionally empty. */
  previewOnly: boolean;
  assignments: Array<{
    principalId: string;
    personaId: string;
    kind: "human" | "workload";
    contractIds: string[];
    actions: Action[];
  }>;
  capabilityGates: CapabilityGate[];
  plan: {
    apply: Array<{ target: string; artifactId: string; operation: "upsert" }>;
    revoke: Array<{ target: string; artifactId: string; operation: "delete" }>;
    readback: Array<{ target: string; artifactId: string; verify: "policy_hash_and_assignments" }>;
  };
  elasticsearch: {
    name: string;
    indices: Array<{
      names: string[];
      privileges: string[];
      query: Record<string, unknown>;
      field_security: { grant: string[]; except: string[] };
    }>;
  }[];
  bw: {
    name: string;
    infoProvider: string;
    characteristics: Array<{ infoObject: string; values: unknown[] }>;
  }[];
  bobj: { groups: string[]; folders: string[] };
  dashboards: { spaces: string[] };
  adf: { identities: string[]; vaultPaths: string[] };
};

const MATCH_ALL = (): Record<string, unknown> => ({ match_all: {} });
const MATCH_NONE = (): Record<string, unknown> => ({ match_none: {} });
const SAFE_FIELD = /^[A-Za-z0-9_.-]+$/;

export function compilePredicateToElasticsearch(
  predicate: Predicate,
  capsule: Capsule,
): Record<string, unknown> {
  switch (predicate.op) {
    case "true":
      return MATCH_ALL();
    case "eq":
      if (!safeField(predicate.field) || !safeTermValue(predicate.value)) return MATCH_NONE();
      return { term: { [predicate.field]: predicate.value } };
    case "in": {
      if (
        !safeField(predicate.field)
        || predicate.values.length === 0
        || predicate.values.some((value) => !safeTermValue(value))
      ) return MATCH_NONE();
      return { terms: { [predicate.field]: [...predicate.values] } };
    }
    case "fromCapsuleAttr": {
      const values = capsule.attrs[predicate.attr];
      if (
        !safeField(predicate.field)
        || !Array.isArray(values)
        || values.length === 0
        || values.some((value) => !safeTermValue(value))
      ) return MATCH_NONE();
      return { terms: { [predicate.field]: [...values] } };
    }
    case "and": {
      if (predicate.clauses.length === 0) return MATCH_ALL();
      return {
        bool: {
          filter: predicate.clauses.map((clause) =>
            compilePredicateToElasticsearch(clause, capsule),
          ),
        },
      };
    }
    case "or": {
      if (predicate.clauses.length === 0) return MATCH_NONE();
      return {
        bool: {
          should: predicate.clauses.map((clause) =>
            compilePredicateToElasticsearch(clause, capsule),
          ),
          minimum_should_match: 1,
        },
      };
    }
    default: {
      const never: never = predicate;
      return never;
    }
  }
}

export function compileCapsule(store: CcaStore, capsuleId: string): CompiledPolicy {
  const capsule = store.capsules.get(capsuleId);
  if (!capsule) throw new Error(`unknown capsule ${capsuleId}`);
  if (!capsule.active) throw new Error(`inactive capsule ${capsuleId}`);

  const bindings = store.bindings.filter((binding) => binding.capsuleId === capsuleId);
  const policySource = {
    capsule,
    bindings: [...bindings].sort((left, right) => left.id.localeCompare(right.id)),
    contracts: bindings.flatMap((binding) => {
      const contract = store.contracts.get(binding.contractId);
      return contract ? [contract] : [];
    }).sort((left, right) => left.id.localeCompare(right.id)),
    datasets: [...new Set(bindings.flatMap((binding) => {
      const contract = store.contracts.get(binding.contractId);
      return contract ? [contract.datasetId] : [];
    }))].flatMap((datasetId) => {
      const dataset = store.datasets.get(datasetId);
      return dataset ? [dataset] : [];
    }).sort((left, right) => left.id.localeCompare(right.id)),
    assigned: store.memberships
      .filter((membership) => membership.capsuleId === capsuleId)
      .map((membership) => {
        const principal = store.principals.get(membership.principalId);
        const personaId = membership.personaId ?? principal?.personaId;
        return {
          principalId: membership.principalId,
          principalDisabled: principal?.disabled,
          principalKind: principal?.kind,
          persona: personaId ? store.personas.get(personaId) : undefined,
        };
      })
      .sort((left, right) => left.principalId.localeCompare(right.principalId)),
  };
  const policyHash = sha256(JSON.stringify(policySource));
  const policyVersion = `cca-${policyHash.slice(0, 24)}`;
  const elasticsearch: CompiledPolicy["elasticsearch"] = [];
  const bw: CompiledPolicy["bw"] = [];
  const spaces: string[] = [];
  const groups: string[] = [];
  const folders: string[] = [];
  const capabilityGates: CapabilityGate[] = [];
  const assignmentMap = new Map<string, CompiledPolicy["assignments"][number]>();

  for (const binding of bindings) {
    const contract = store.contracts.get(binding.contractId);
    if (!contract) throw new Error(`binding ${binding.id} references unknown contract`);
    if (contract.approvalRequired) continue;
    const dataset = store.datasets.get(contract.datasetId);
    if (!dataset) throw new Error(`contract ${contract.id} references unknown dataset`);
    const datasetAllowedFields = canonicalFieldPaths(dataset.allowedFields);
    const contractAllowedFields = canonicalFieldPaths(contract.allowFields ?? dataset.allowedFields);
    if (!datasetAllowedFields) throw new Error(`dataset ${dataset.id} has an invalid field allowlist`);
    if (!contractAllowedFields) throw new Error(`contract ${contract.id} has an invalid field allowlist`);
    const allowedFields = intersectFieldPaths(datasetAllowedFields, contractAllowedFields);
    if (allowedFields.length === 0) {
      capabilityGates.push(blockedGate("elasticsearch", contract, ["field_allowlist"], [], "empty field intersection"));
      continue;
    }
    const roleName = nativeId(`cca-${capsuleId}-${contract.id}`);
    const classificationAllowed =
      CLASS_RANK[dataset.classification] <= CLASS_RANK[contract.classificationMax];

    const eligibleMembers = eligibleAssignments(store, capsuleId, contract, dataset);
    for (const eligible of eligibleMembers) {
      const key = `${eligible.principalId}\u0000${eligible.personaId}`;
      const current = assignmentMap.get(key);
      if (current) {
        current.contractIds = [...new Set([...current.contractIds, contract.id])].sort();
        current.actions = [...new Set([...current.actions, ...eligible.actions])].sort() as Action[];
      } else {
        assignmentMap.set(key, { ...eligible, contractIds: [contract.id] });
      }
    }

    if (contract.actions.includes("view")) {
      const required = requiredCapabilities(contract, datasetAllowedFields, allowedFields);
      const supported: EnforcementCapability[] = [
        "classification_ceiling",
        "field_allowlist",
        "field_denylist",
        ...(predicateSupportedByElasticsearch(contract.predicate, capsule) ? ["row_filter" as const] : []),
      ];
      const gate = gateFor("elasticsearch", contract, required, supported, classificationAllowed);
      capabilityGates.push(gate);
      elasticsearch.push({
        name: roleName,
        indices: [
          {
            // This remains preview-only until a purpose-bound assignment PEP exists.
            names: [`${nativeId(dataset.id)}-*`],
            privileges: ["read"],
            query: classificationAllowed
              ? compilePredicateToElasticsearch(contract.predicate, capsule)
              : MATCH_NONE(),
            field_security: {
              grant: allowedFields,
              except: [...new Set(contract.denyFields)].sort(),
            },
          },
        ],
      });
    }

    if (contract.datasetId === "bw_vendor" || contract.datasetId === "pc_detail") {
      const required = requiredCapabilities(contract, datasetAllowedFields, allowedFields);
      const supported: EnforcementCapability[] = [
        "classification_ceiling",
        ...(predicateSupportedByBw(contract.predicate, capsule) ? ["row_filter" as const] : []),
      ];
      const gate = gateFor("bw", contract, required, supported, classificationAllowed);
      capabilityGates.push(gate);
      bw.push({
        name: nativeId(`ZCCA_${capsuleId.replaceAll("-", "_")}`).toUpperCase(),
        infoProvider: contract.datasetId === "bw_vendor" ? "ZVNDR_ANL" : "ZPC_MON",
        characteristics: [{
          infoObject: "0VENDOR",
          values: classificationAllowed ? compileBwVendorValues(contract.predicate, capsule) : [],
        }],
      });
    }

    if (classificationAllowed && (contract.datasetId === "bw_vendor" || contract.id.startsWith("health"))) {
      const gate = gateFor(
        "dashboard",
        contract,
        requiredCapabilities(contract, datasetAllowedFields, allowedFields),
        ["classification_ceiling"],
        classificationAllowed,
      );
      capabilityGates.push(gate);
      spaces.push(capsuleId);
    }
    if (classificationAllowed && contract.datasetId === "bobj") {
      const gate = gateFor(
        "bobj",
        contract,
        requiredCapabilities(contract, datasetAllowedFields, allowedFields),
        ["classification_ceiling"],
        classificationAllowed,
      );
      capabilityGates.push(gate);
      groups.push(nativeId(`BOBJ_${capsuleId}`).toUpperCase());
      folders.push(`/ops/${nativeId(capsuleId)}`);
    }
  }

  const assignments = [...assignmentMap.values()].sort((left, right) =>
    `${left.principalId}\u0000${left.personaId}`.localeCompare(`${right.principalId}\u0000${right.personaId}`)
  );
  const workloadAssignments = assignments.filter((assignment) => assignment.kind === "workload");
  const needsRuntimeIdentity = bindings.some((binding) => {
    const contract = store.contracts.get(binding.contractId);
    const dataset = contract ? store.datasets.get(contract.datasetId) : undefined;
    if (
      !contract
      || !dataset
      || contract.approvalRequired
      || CLASS_RANK[dataset.classification] > CLASS_RANK[contract.classificationMax]
    ) return false;
    return contract.actions.includes("operate") || contract.actions.includes("rotate");
  });
  const emitRuntimeIdentity = workloadAssignments.length > 0 && needsRuntimeIdentity;
  const safeCapsuleId = nativeId(capsuleId);
  if (needsRuntimeIdentity) {
    const required: EnforcementCapability[] = ["workload_identity", "purpose_binding", "classification_ceiling"];
    const supported: EnforcementCapability[] = emitRuntimeIdentity ? ["workload_identity"] : [];
    const missing = required.filter((capability) => !supported.includes(capability));
    capabilityGates.push({
      target: "adf",
      contractId: bindings.find((binding) => {
        const contract = store.contracts.get(binding.contractId);
        return contract?.actions.some((action) => action === "operate" || action === "rotate");
      })?.contractId ?? "runtime",
      datasetId: "pipeline-runtime",
      required,
      supported,
      missing,
      status: missing.length === 0 ? "eligible" : "blocked",
      reason: missing.includes("workload_identity")
        ? "no eligible active workload assignment and no purpose-bound source/target policy"
        : "managed identity alone cannot enforce purpose or data classification",
    });
  }

  const identities = emitRuntimeIdentity
    ? workloadAssignments.map((assignment) =>
      `spiffe://cca/capsule/${safeCapsuleId}/workload/${nativeId(assignment.principalId)}`
    )
    : [];
  const vaultPaths = emitRuntimeIdentity ? [`secret/cca/${safeCapsuleId}/*`] : [];

  const desiredApply = [
    ...elasticsearch.map((artifact) => ({ target: "elasticsearch", artifactId: artifact.name, operation: "upsert" as const })),
    ...bw.map((artifact) => ({ target: "bw", artifactId: artifact.name, operation: "upsert" as const })),
    ...groups.map((artifactId) => ({ target: "bobj", artifactId, operation: "upsert" as const })),
    ...[...new Set(spaces)].map((artifactId) => ({ target: "dashboard", artifactId, operation: "upsert" as const })),
    ...identities.map((artifactId) => ({ target: "adf", artifactId, operation: "upsert" as const })),
  ];
  const deploymentStatus = capabilityGates.some((gate) => gate.status === "blocked") ? "blocked" : "deployable";
  const apply = deploymentStatus === "deployable" ? desiredApply : [];

  return {
    capsuleId,
    policyVersion,
    policyHash,
    deploymentStatus,
    previewOnly: deploymentStatus === "blocked",
    assignments,
    capabilityGates,
    plan: {
      apply,
      revoke: apply.map(({ target, artifactId }) => ({ target, artifactId, operation: "delete" })),
      readback: apply.map(({ target, artifactId }) => ({
        target,
        artifactId,
        verify: "policy_hash_and_assignments",
      })),
    },
    elasticsearch,
    bw,
    bobj: { groups, folders },
    dashboards: { spaces: [...new Set(spaces)] },
    adf: {
      identities,
      vaultPaths,
    },
  };
}

export function compileAll(store: CcaStore): CompiledPolicy[] {
  return [...store.capsules.values()]
    .filter((capsule) => capsule.active)
    .map((capsule) => compileCapsule(store, capsule.id));
}

export function samplePredicateHolds(
  store: CcaStore,
  contract: Contract,
  capsule: Capsule,
): boolean {
  const row = store.records.find((record) => record.datasetId === contract.datasetId);
  if (!row) return false;
  return evalPredicate(contract.predicate, row.attrs, capsule);
}

function compileBwVendorValues(predicate: Predicate, capsule: Capsule): unknown[] {
  switch (predicate.op) {
    case "true":
      return ["*"];
    case "eq":
      return predicate.field === "vendor_id" && safeTermValue(predicate.value)
        ? [predicate.value]
        : [];
    case "in":
      return predicate.field === "vendor_id" && predicate.values.every(safeTermValue)
        ? [...predicate.values]
        : [];
    case "fromCapsuleAttr": {
      const values = capsule.attrs[predicate.attr];
      return predicate.field === "vendor_id"
        && Array.isArray(values)
        && values.every(safeTermValue)
        ? [...values]
        : [];
    }
    case "and": {
      let values: unknown[] = ["*"];
      for (const clause of predicate.clauses) {
        values = intersectBwValues(values, compileBwVendorValues(clause, capsule));
        if (values.length === 0) break;
      }
      return values;
    }
    case "or": {
      const values = predicate.clauses.map((clause) => compileBwVendorValues(clause, capsule));
      if (values.some((items) => items.includes("*"))) return ["*"];
      return [...new Set(values.flat())];
    }
    default: {
      const never: never = predicate;
      return never;
    }
  }
}

function intersectBwValues(left: unknown[], right: unknown[]): unknown[] {
  if (left.includes("*")) return [...right];
  if (right.includes("*")) return [...left];
  return left.filter((value) => right.some((candidate) => candidate === value));
}

function safeField(field: string): boolean {
  return SAFE_FIELD.test(field) && !field.split(".").some((part) =>
    part === "__proto__" || part === "prototype" || part === "constructor"
  );
}

function safeTermValue(value: unknown): boolean {
  return typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function nativeId(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 107);
  if (!normalized) throw new Error("native policy id is empty after normalization");
  return `${normalized}-${sha256(value).slice(0, 12)}`;
}

function requiredCapabilities(
  contract: Contract,
  datasetAllowedFields: string[],
  effectiveAllowedFields: string[],
): EnforcementCapability[] {
  const required: EnforcementCapability[] = ["classification_ceiling", "purpose_binding"];
  if (contract.predicate.op !== "true") required.push("row_filter");
  if (
    contract.allowFields !== undefined
    || effectiveAllowedFields.length !== datasetAllowedFields.length
    || effectiveAllowedFields.some((field, index) => field !== datasetAllowedFields[index])
  ) required.push("field_allowlist");
  if (contract.denyFields.length > 0) required.push("field_denylist");
  return [...new Set(required)];
}

function gateFor(
  target: CapabilityGate["target"],
  contract: Contract,
  required: EnforcementCapability[],
  supported: EnforcementCapability[],
  classificationAllowed: boolean,
): CapabilityGate {
  const effectiveSupported = classificationAllowed
    ? [...new Set(supported)]
    : [...new Set(supported.filter((capability) => capability !== "classification_ceiling"))];
  const missing = required.filter((capability) => !effectiveSupported.includes(capability));
  return {
    target,
    contractId: contract.id,
    datasetId: contract.datasetId,
    required,
    supported: effectiveSupported,
    missing,
    status: missing.length === 0 ? "eligible" : "blocked",
    ...(missing.length === 0
      ? {}
      : { reason: `target cannot prove: ${missing.join(", ")}` }),
  };
}

function blockedGate(
  target: CapabilityGate["target"],
  contract: Contract,
  required: EnforcementCapability[],
  supported: EnforcementCapability[],
  reason: string,
): CapabilityGate {
  return {
    target,
    contractId: contract.id,
    datasetId: contract.datasetId,
    required,
    supported,
    missing: required.filter((capability) => !supported.includes(capability)),
    status: "blocked",
    reason,
  };
}

function eligibleAssignments(
  store: CcaStore,
  capsuleId: string,
  contract: Contract,
  dataset: Dataset,
): CompiledPolicy["assignments"] {
  return store.memberships.flatMap((membership) => {
    if (membership.capsuleId !== capsuleId) return [];
    const principal = store.principals.get(membership.principalId);
    const persona = store.personas.get(membership.personaId ?? principal?.personaId ?? "");
    if (
      !principal
      || principal.disabled
      || !persona
      || !personaMatchesContract(persona, contract.allowedPersonas)
      || persona.ceiling === "none"
      || CLASS_RANK[dataset.classification] > CLASS_RANK[persona.ceiling]
      || CLASS_RANK[dataset.classification] > CLASS_RANK[contract.classificationMax]
    ) return [];
    const actions = contract.actions.filter((action) => persona.actions.includes(action));
    if (actions.length === 0) return [];
    return [{
      principalId: principal.id,
      personaId: persona.id,
      kind: principal.kind,
      contractIds: [contract.id],
      actions,
    }];
  });
}

function predicateSupportedByElasticsearch(predicate: Predicate, capsule: Capsule): boolean {
  switch (predicate.op) {
    case "true":
      return true;
    case "eq":
      return safeField(predicate.field) && safeTermValue(predicate.value);
    case "in":
      return safeField(predicate.field)
        && predicate.values.length > 0
        && predicate.values.every(safeTermValue);
    case "fromCapsuleAttr": {
      const values = capsule.attrs[predicate.attr];
      return safeField(predicate.field)
        && Array.isArray(values)
        && values.length > 0
        && values.every(safeTermValue);
    }
    case "and":
      return predicate.clauses.every((clause) => predicateSupportedByElasticsearch(clause, capsule));
    case "or":
      return predicate.clauses.length > 0
        && predicate.clauses.every((clause) => predicateSupportedByElasticsearch(clause, capsule));
    default: {
      const never: never = predicate;
      return never;
    }
  }
}

function predicateSupportedByBw(predicate: Predicate, capsule: Capsule): boolean {
  return compileBwVendorValues(predicate, capsule).length > 0;
}
