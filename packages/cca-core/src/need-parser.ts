import {
  SAP_WAREHOUSE_PRODUCTS,
  WAREHOUSE_DEPARTMENTS,
  WAREHOUSE_PRODUCTS,
  WAREHOUSE_REGIONS,
  WAREHOUSE_TENANTS,
  emptyRoleDraft,
  type RoleDraft,
} from "./role-draft.js";
import type { Action, Classification } from "./types.js";

export const SAP_PRODUCTS = SAP_WAREHOUSE_PRODUCTS;
export const GENERIC_PRODUCTS = WAREHOUSE_PRODUCTS;

export const PII_FIELDS = [
  "email",
  "account_number",
  "payload",
  "vendor_id",
  "bank_account",
  "legal_name",
] as const;

export type ParsedNeed = {
  draft: RoleDraft;
  rationale: string[];
  ask: string;
};

const PRODUCT_PHRASES: Array<{ needles: string[]; product: string }> = [
  { needles: ["process chain", "process-chain", "pc health", "chain health", "rspc"], product: "process_chains" },
  { needles: ["bw vendor", "bw analytics", "infoprovider", "sap bw", "vendor analytics"], product: "bw_vendor" },
  { needles: ["s4", "s/4", "vendor master", "hana"], product: "s4_master" },
  { needles: ["bobj", "business objects", "universe", "webi"], product: "bobj" },
  { needles: ["elastic", "es log", "es/pipeline", "pipeline log", "kibana"], product: "es_logs" },
  { needles: ["customer"], product: "customers" },
  { needles: ["transaction", "spend"], product: "transactions" },
  { needles: ["inventory", "stock"], product: "inventory" },
  { needles: ["ticket"], product: "tickets" },
  { needles: ["telemetry", "metric"], product: "telemetry" },
  { needles: ["event"], product: "events" },
];

export function parseNeedToRole(ask: string): ParsedNeed {
  const text = ask.trim();
  const lower = text.toLowerCase();
  const rationale: string[] = [];
  const draft = emptyRoleDraft();

  draft.verbs = detectVerbs(lower, rationale);
  draft.purpose = detectPurpose(lower, rationale);
  draft.products = detectProducts(lower, rationale);
  draft.tenants = detectList(lower, WAREHOUSE_TENANTS, rationale, "tenant");
  draft.regions = detectRegions(lower, rationale);
  draft.departments = detectList(lower, WAREHOUSE_DEPARTMENTS, rationale, "department");
  draft.denyFields = detectMasks(lower, rationale);
  draft.ceiling = detectCeiling(lower, draft, rationale);
  draft.sources = sourcesFor(draft.products);
  draft.name = nameFromAsk(text, draft);

  if (draft.sources.length) {
    rationale.push(`sources: ${draft.sources.join(", ")}`);
  }
  if (draft.products.length === 0) {
    rationale.push("no product matched — add one on the canvas before apply");
  }

  return { draft, rationale, ask: text };
}

function detectVerbs(lower: string, rationale: string[]): Action[] {
  const verbs = new Set<Action>(["view"]);
  if (/\b(operate|repair|fix|process chain monitor|l2)\b/.test(lower)) {
    verbs.add("operate");
    rationale.push("verb operate — repair / L2 / operate language");
  }
  if (/\b(rotate|secret|credential)\b/.test(lower)) {
    verbs.add("rotate");
    rationale.push("verb rotate — secrets / credentials");
  }
  if (/\b(administer|admin access|maintain)\b/.test(lower) && !/\bplatform admin\b/.test(lower)) {
    verbs.add("administer");
    rationale.push("verb administer — maintain language");
  }
  if (/\baudit\b/.test(lower)) {
    verbs.add("audit");
    rationale.push("verb audit");
  }
  rationale.push("verb view — deny-by-default still requires an explicit product");
  return [...verbs];
}

function detectPurpose(lower: string, rationale: string[]): string {
  if (/\bfinance|spend|invoice\b/.test(lower)) {
    rationale.push("purpose finance");
    return "finance";
  }
  if (/\baudit|compliance\b/.test(lower)) {
    rationale.push("purpose audit");
    return "audit";
  }
  if (/\bobserv|pipeline|sre|reliab|operation/.test(lower)) {
    rationale.push("purpose operations");
    return "operations";
  }
  if (/\banalytics|dashboard|report\b/.test(lower)) {
    rationale.push("purpose analytics");
    return "analytics";
  }
  rationale.push("purpose support — default for incident / L1 / unspecified asks");
  return "support";
}

function detectProducts(lower: string, rationale: string[]): string[] {
  const found = new Set<string>();
  for (const rule of PRODUCT_PHRASES) {
    if (rule.needles.some((needle) => lower.includes(needle))) {
      found.add(rule.product);
    }
  }
  if (/\bl1\b/.test(lower) && /\b(health|status|monitor|support)\b/.test(lower) && found.size === 0) {
    found.add("process_chains");
  }
  if (found.size) rationale.push(`products: ${[...found].join(", ")}`);
  return [...found];
}

function detectList(
  lower: string,
  values: readonly string[],
  rationale: string[],
  label: string,
): string[] {
  const hit = values.filter((value) => lower.includes(value.toLowerCase()));
  if (hit.length) rationale.push(`${label}s: ${hit.join(", ")}`);
  return hit;
}

function detectRegions(lower: string, rationale: string[]): string[] {
  const regions: string[] = [];
  if (/\bna\b|north america/.test(lower)) regions.push("NA");
  if (/\beu\b|europe/.test(lower)) regions.push("EU");
  if (/\bapac\b|asia/.test(lower)) regions.push("APAC");
  if (/\blatam\b|latin/.test(lower)) regions.push("LATAM");
  const extra = WAREHOUSE_REGIONS.filter(
    (region) =>
      !regions.includes(region) && new RegExp(`\\b${region}\\b`, "i").test(lower),
  );
  const all = [...new Set([...regions, ...extra])];
  if (all.length) rationale.push(`regions: ${all.join(", ")}`);
  return all;
}

function detectMasks(lower: string, rationale: string[]): string[] {
  const masks = new Set<string>();
  const hidePii =
    /not (vendor )?pii|no (vendor )?pii|without pii|hide pii|pii stripped|not expose/.test(lower);
  if (hidePii || /payload strip|strip(ped)? payload|no payload|without payload/.test(lower)) {
    masks.add("payload");
  }
  if (hidePii || /not vendor|no vendor (name|id|pii)|vendor pii/.test(lower)) {
    masks.add("vendor_id");
    masks.add("legal_name");
  }
  if (hidePii || /bank|account number|no account/.test(lower)) {
    masks.add("account_number");
    masks.add("bank_account");
  }
  if (hidePii || /no email|hide email/.test(lower)) {
    masks.add("email");
  }
  if (masks.size) rationale.push(`field masks: ${[...masks].join(", ")}`);
  return [...masks];
}

function detectCeiling(lower: string, draft: RoleDraft, rationale: string[]): Classification {
  if (draft.products.includes("s4_master") && !/not |no |without /.test(lower)) {
    rationale.push("ceiling restricted — S/4 vendor master");
    return "restricted";
  }
  if (/\brestricted\b/.test(lower)) {
    rationale.push("ceiling restricted");
    return "restricted";
  }
  if (
    /\bl1\b/.test(lower) ||
    /\bobserv/.test(lower) ||
    draft.denyFields.includes("payload") ||
    draft.products.includes("process_chains") && !draft.products.includes("bw_vendor")
  ) {
    rationale.push("ceiling internal — health / observability / stripped payload");
    return "internal";
  }
  if (/\bconfidential\b/.test(lower) || draft.purpose === "finance" || draft.products.includes("bw_vendor")) {
    rationale.push("ceiling confidential");
    return "confidential";
  }
  rationale.push("ceiling internal — default least privilege");
  return "internal";
}

function sourcesFor(products: string[]): string[] {
  const sources: string[] = [];
  if (products.some((product) => (SAP_PRODUCTS as readonly string[]).includes(product))) {
    sources.push("sap");
  }
  if (products.some((product) => (GENERIC_PRODUCTS as readonly string[]).includes(product))) {
    sources.push("generic");
  }
  return sources;
}

function nameFromAsk(ask: string, draft: RoleDraft): string {
  if (ask.length > 0 && ask.length <= 48) return ask;
  const bits = [
    draft.tenants.join(" "),
    draft.regions.join(" "),
    draft.purpose,
    draft.products.slice(0, 2).join(" "),
  ].filter(Boolean);
  return bits.join(" ").trim() || "generated role";
}
