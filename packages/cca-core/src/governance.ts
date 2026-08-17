import type { CcaStore } from "./store.js";
import type { Action, Classification } from "./types.js";
import type { RoleDraft } from "./role-draft.js";

export type SodRuleSeverity = "high" | "critical";

export type SodCapabilitySelector = {
  actions?: Action[];
  products?: string[];
  purposes?: string[];
};

export type SodRule = {
  id: string;
  version: number;
  title: string;
  severity: SodRuleSeverity;
  rationale: string;
  remediation: string;
  left: SodCapabilitySelector;
  right: SodCapabilitySelector;
};

export type SodFact = {
  source: "candidate" | "standing";
  principalId: string;
  purpose: string;
  actions: Action[];
  products: string[];
  ceiling: Classification;
  capsuleId?: string;
  contractId?: string;
};

export type SodViolation = {
  ruleId: string;
  ruleVersion: number;
  title: string;
  severity: SodRuleSeverity;
  rationale: string;
  remediation: string;
  principalId: string;
  evidence: {
    left: SodFact;
    right: SodFact;
  };
};

/**
 * Versioned, executable separation-of-duties policy for warehouse roles. The
 * rules are deliberately data/product based rather than application based, so
 * the same policy survives a change from SAP/BW to another source or target.
 */
export const WAREHOUSE_SOD_RULES: readonly SodRule[] = Object.freeze(([
  {
    id: "SOD-WH-001",
    version: 1,
    title: "Vendor master maintenance and financial transaction operation",
    severity: "critical",
    rationale: "One identity must not be able to change vendor master data and operate financial transactions.",
    remediation: "Split master-data and transaction-operation duties between independently reviewed identities.",
    left: { actions: ["operate"], products: ["s4_master"] },
    right: { actions: ["operate"], products: ["transactions"] },
  },
  {
    id: "SOD-WH-002",
    version: 1,
    title: "Audit evidence must remain read-only",
    severity: "critical",
    rationale: "An auditor who can operate the reviewed data path can alter the subject of the audit.",
    remediation: "Keep the audit role view-only and route operational changes through a separate operations role.",
    left: { purposes: ["audit"] },
    right: { actions: ["operate"] },
  },
  {
    id: "SOD-WH-003",
    version: 1,
    title: "Data-governance oversight must not operate governed workloads",
    severity: "high",
    rationale: "The identity that defines or attests data access should not operate the governed data products.",
    remediation: "Use a data-owner identity for oversight and a separately approved operator identity for workload actions.",
    left: { purposes: ["data-governance"] },
    right: { actions: ["operate"] },
  },
] satisfies SodRule[]).map(freezeSodRule));

export class SodPolicyViolationError extends Error {
  readonly code = "sod_policy_violation";

  constructor(readonly violations: SodViolation[]) {
    super(`separation-of-duties policy blocked the role: ${violations.map((item) => item.ruleId).join(", ")}`);
  }
}

/** Evaluate a candidate as it will exist after old Role Studio scopes retire. */
export function evaluateRoleDraftSod(
  store: CcaStore,
  principalId: string,
  draft: RoleDraft,
): SodViolation[] {
  const standing = warehouseSodFactsFor(store, principalId, { excludeManagedRoleStudio: true });
  const candidate: SodFact = {
    source: "candidate",
    principalId,
    purpose: draft.purpose,
    actions: unique(draft.verbs),
    products: unique(draft.products),
    ceiling: draft.ceiling,
  };
  return evaluateSodFacts([...standing, candidate]);
}

/** Evaluate the access that is currently active for a principal. */
export function evaluatePrincipalSod(store: CcaStore, principalId: string): SodViolation[] {
  return evaluateSodFacts(warehouseSodFactsFor(store, principalId));
}

export function warehouseSodFactsFor(
  store: CcaStore,
  principalId: string,
  options: { excludeManagedRoleStudio?: boolean } = {},
): SodFact[] {
  const facts: SodFact[] = [];
  for (const { membership, capsule, persona } of store.liveMembershipsFor(principalId)) {
    if (options.excludeManagedRoleStudio && capsule.attrs.managedBy === "role-studio") continue;
    // A warehouse capability without a machine-readable product scope is
    // conservatively treated as spanning every product for SoD evaluation.
    const scopedProducts = stringArray(capsule.attrs.products);
    const products = scopedProducts.length > 0 ? scopedProducts : ["*"];
    for (const binding of store.bindings) {
      if (binding.capsuleId !== membership.capsuleId) continue;
      const contract = store.contracts.get(binding.contractId);
      if (!contract || contract.datasetId !== "warehouse") continue;
      const actions = contract.actions.filter((action) => persona.actions.includes(action));
      if (actions.length === 0) continue;
      facts.push({
        source: "standing",
        principalId,
        purpose: contract.purpose,
        actions: unique(actions),
        products,
        ceiling: contract.classificationMax,
        capsuleId: capsule.id,
        contractId: contract.id,
      });
    }
  }
  return facts;
}

export function evaluateSodFacts(facts: SodFact[]): SodViolation[] {
  const violations: SodViolation[] = [];
  const seen = new Set<string>();
  for (const rule of WAREHOUSE_SOD_RULES) {
    for (const left of facts) {
      if (!matches(left, rule.left)) continue;
      for (const right of facts) {
        if (!matches(right, rule.right)) continue;
        const principalId = left.principalId;
        if (right.principalId !== principalId) continue;
        const key = `${rule.id}\u0000${principalId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push({
          ruleId: rule.id,
          ruleVersion: rule.version,
          title: rule.title,
          severity: rule.severity,
          rationale: rule.rationale,
          remediation: rule.remediation,
          principalId,
          evidence: { left: structuredClone(left), right: structuredClone(right) },
        });
      }
    }
  }
  return violations;
}

function matches(fact: SodFact, selector: SodCapabilitySelector): boolean {
  return (
    includesAny(fact.actions, selector.actions)
    && (selector.products === undefined
      || fact.products.includes("*")
      || selector.products.some((product) => fact.products.includes(product)))
    && (selector.purposes === undefined || selector.purposes.includes(fact.purpose))
  );
}

function includesAny<T>(values: T[], required?: T[]): boolean {
  return required === undefined || required.some((value) => values.includes(value));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(value.filter((item): item is string => typeof item === "string"));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function freezeSodRule(rule: SodRule): SodRule {
  for (const selector of [rule.left, rule.right]) {
    if (selector.actions) Object.freeze(selector.actions);
    if (selector.products) Object.freeze(selector.products);
    if (selector.purposes) Object.freeze(selector.purposes);
    Object.freeze(selector);
  }
  return Object.freeze(rule);
}
