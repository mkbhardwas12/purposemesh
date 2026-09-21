import { CLASS_RANK } from "./types.js";
import type { Action, Classification, Predicate } from "./types.js";

export const WAREHOUSE_PRODUCTS = [
  "customers",
  "transactions",
  "events",
  "inventory",
  "tickets",
  "telemetry",
] as const;

export const SAP_WAREHOUSE_PRODUCTS = [
  "process_chains",
  "bw_vendor",
  "s4_master",
  "bobj",
  "es_logs",
] as const;

export const ALL_WAREHOUSE_PRODUCTS = [
  ...SAP_WAREHOUSE_PRODUCTS,
  ...WAREHOUSE_PRODUCTS,
] as const;

export const WAREHOUSE_TENANTS = ["ACME", "GLOBEX", "NOVA", "HELIOS", "ATLAS"] as const;
export const WAREHOUSE_REGIONS = ["NA", "EU", "APAC", "LATAM"] as const;
export const WAREHOUSE_DEPARTMENTS = [
  "sales",
  "finance",
  "ops",
  "support",
  "engineering",
] as const;
export const WAREHOUSE_PURPOSES = [
  "analytics",
  "support",
  "finance",
  "operations",
  "audit",
  "data-governance",
] as const;
export const WAREHOUSE_MASKS = [
  "email",
  "account_number",
  "payload",
  "vendor_id",
  "bank_account",
  "legal_name",
] as const;

export const WAREHOUSE_SOURCES = ["sap", "generic"] as const;

export const WAREHOUSE_ROLE_ACTIONS = ["view", "operate"] as const satisfies readonly Action[];

/** Curated public schema for warehouse rows. Internal implementation columns are omitted. */
export const WAREHOUSE_ALLOWED_FIELDS = [
  "id",
  "pipeline_id",
  "pipeline_name",
  "source_system",
  "target_system",
  "product",
  "tenant",
  "region",
  "department",
  "sensitivity",
  "amount",
  "occurred_at",
  "email",
  "account_number",
  "payload",
  "title",
  "status",
  "source",
  "vendor_id",
  "bank_account",
  "legal_name",
] as const;

export type WarehouseProduct = (typeof WAREHOUSE_PRODUCTS)[number];

export type RoleDraft = {
  name: string;
  verbs: Action[];
  purpose: string;
  ceiling: Classification;
  products: string[];
  tenants: string[];
  regions: string[];
  departments: string[];
  denyFields: string[];
  sources: string[];
};

export type SqlFilter = {
  sql: string;
  params: unknown[];
};

export type DataScope = {
  products: string[];
  tenants: string[];
  regions: string[];
  departments: string[];
  sources: string[];
  ceiling: Classification;
};

export function emptyRoleDraft(): RoleDraft {
  return {
    name: "",
    verbs: [],
    purpose: "",
    ceiling: "internal",
    products: [],
    tenants: [],
    regions: [],
    departments: [],
    denyFields: [],
    sources: [],
  };
}

export function slugifyRoleName(name: string): string {
  // Lowercase the whole string first to preserve Unicode's contextual mappings.
  // Each code unit is then visited at most once and output is bounded to 40;
  // unlike an unanchored trailing-separator regexp, there is no backtracking.
  const lower = name.toLowerCase();
  let slug = "";
  let separatorPending = false;
  for (let index = 0; index < lower.length && slug.length < 40; index += 1) {
    const code = lower.charCodeAt(index);
    if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
      // Only materialize a separator when another word follows. Truncation may
      // retain this separator at position 40, matching trim-before-slice behavior.
      if (separatorPending) slug += "-";
      if (slug.length < 40) slug += lower[index];
      separatorPending = false;
    } else if (slug.length > 0) {
      separatorPending = true;
    }
  }
  return slug || `draft-${Date.now()}`;
}

export function validateRoleDraft(draft: RoleDraft): string[] {
  const errors: string[] = [];
  if (typeof draft.name !== "string" || !draft.name.trim()) errors.push("name is required");
  else if (draft.name.trim().length > 80) errors.push("name must be at most 80 characters");

  const validActions = new Set<Action>(WAREHOUSE_ROLE_ACTIONS);
  if (!Array.isArray(draft.verbs) || draft.verbs.length === 0) {
    errors.push("drop at least one verb");
  } else if (draft.verbs.some((action) => !validActions.has(action))) {
    errors.push("unknown verb");
  }

  if (
    typeof draft.purpose !== "string"
    || !(WAREHOUSE_PURPOSES as readonly string[]).includes(draft.purpose)
  ) {
    errors.push("choose an approved purpose");
  }
  if (!Object.hasOwn(CLASS_RANK, draft.ceiling)) errors.push("choose a valid classification ceiling");

  validateValues(errors, draft.products, ALL_WAREHOUSE_PRODUCTS, "product");
  validateValues(errors, draft.tenants, WAREHOUSE_TENANTS, "tenant");
  validateValues(errors, draft.regions, WAREHOUSE_REGIONS, "region");
  validateValues(errors, draft.departments, WAREHOUSE_DEPARTMENTS, "department");
  validateValues(errors, draft.denyFields, WAREHOUSE_MASKS, "field mask");
  validateValues(errors, draft.sources, WAREHOUSE_SOURCES, "source");

  if (
    Array.isArray(draft.verbs)
    && draft.verbs.length > 0
    && (!Array.isArray(draft.products) || draft.products.length === 0)
  ) {
    errors.push("drop at least one data product");
  }
  return errors;
}

function validateValues(
  errors: string[],
  values: unknown,
  allowed: readonly string[],
  label: string,
): void {
  if (!Array.isArray(values)) {
    errors.push(`${label}s must be an array`);
    return;
  }
  if (values.some((value) => typeof value !== "string" || !allowed.includes(value))) {
    errors.push(`unknown ${label}`);
  }
  if (new Set(values).size !== values.length) errors.push(`duplicate ${label}`);
}

export function scopeFromDraft(draft: RoleDraft): DataScope {
  return {
    products: [...draft.products],
    tenants: [...draft.tenants],
    regions: [...draft.regions],
    departments: [...draft.departments],
    sources: [...(draft.sources ?? [])],
    ceiling: draft.ceiling,
  };
}

export function compileScopeToSql(scope: DataScope): SqlFilter {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (scope.products.length === 0) {
    return { sql: "1=0", params: [] };
  }
  if (!Object.hasOwn(CLASS_RANK, scope.ceiling)) {
    return { sql: "1=0", params: [] };
  }
  clauses.push(`product IN (${scope.products.map(() => "?").join(",")})`);
  params.push(...scope.products);
  if (scope.tenants.length > 0) {
    clauses.push(`tenant IN (${scope.tenants.map(() => "?").join(",")})`);
    params.push(...scope.tenants);
  }
  if (scope.regions.length > 0) {
    clauses.push(`region IN (${scope.regions.map(() => "?").join(",")})`);
    params.push(...scope.regions);
  }
  if (scope.departments.length > 0) {
    clauses.push(`department IN (${scope.departments.map(() => "?").join(",")})`);
    params.push(...scope.departments);
  }
  if (scope.sources?.length > 0) {
    clauses.push(`source IN (${scope.sources.map(() => "?").join(",")})`);
    params.push(...scope.sources);
  }
  clauses.push("class_rank <= ?");
  params.push(CLASS_RANK[scope.ceiling]);
  return { sql: clauses.join(" AND "), params };
}

export function orSqlFilters(filters: SqlFilter[]): SqlFilter {
  if (filters.length === 0) return { sql: "1=0", params: [] };
  if (filters.length === 1) return filters[0]!;
  return {
    sql: filters.map((filter) => `(${filter.sql})`).join(" OR "),
    params: filters.flatMap((filter) => filter.params),
  };
}

export function draftToPredicate(draft: RoleDraft): Predicate {
  const clauses: Predicate[] = [];
  if (draft.products.length > 0) {
    clauses.push({ op: "in", field: "product", values: [...draft.products] });
  }
  if (draft.tenants.length > 0) {
    clauses.push({ op: "fromCapsuleAttr", field: "tenant", attr: "tenants" });
  }
  if (draft.regions.length > 0) {
    clauses.push({ op: "fromCapsuleAttr", field: "region", attr: "regions" });
  }
  if (draft.departments.length > 0) {
    clauses.push({ op: "fromCapsuleAttr", field: "department", attr: "departments" });
  }
  if (draft.sources.length > 0) {
    clauses.push({ op: "fromCapsuleAttr", field: "source", attr: "sources" });
  }
  if (clauses.length === 0) return { op: "true" };
  if (clauses.length === 1) return clauses[0]!;
  return { op: "and", clauses };
}

export function toggleList(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export const ROLE_PALETTE = {
  verbs: [
    { id: "view", label: "view", group: "verb" },
    { id: "operate", label: "operate", group: "verb" },
  ],
  purposes: WAREHOUSE_PURPOSES.map((id) => ({ id, label: id, group: "purpose" })),
  ceilings: [
    { id: "internal", label: "internal", group: "ceiling" },
    { id: "confidential", label: "confidential", group: "ceiling" },
    { id: "restricted", label: "restricted", group: "ceiling" },
  ],
  products: [
    ...SAP_WAREHOUSE_PRODUCTS.map((id) => ({
      id,
      label: `${id.replaceAll("_", " ")} (SAP)`,
      group: "product",
    })),
    ...WAREHOUSE_PRODUCTS.map((id) => ({ id, label: `${id} (generic)`, group: "product" })),
  ],
  sources: WAREHOUSE_SOURCES.map((id) => ({ id, label: id, group: "source" })),
  tenants: WAREHOUSE_TENANTS.map((id) => ({ id, label: id, group: "tenant" })),
  regions: WAREHOUSE_REGIONS.map((id) => ({ id, label: id, group: "region" })),
  departments: WAREHOUSE_DEPARTMENTS.map((id) => ({ id, label: id, group: "department" })),
  masks: WAREHOUSE_MASKS.map((id) => ({ id, label: `hide ${id}`, group: "mask" })),
} as const;
