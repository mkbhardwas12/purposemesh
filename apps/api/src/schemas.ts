const id = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9._:-]+$",
} as const;

const shortText = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  pattern: "\\S",
} as const;

const stringList = (values: readonly string[], maxItems = values.length) => ({
  type: "array",
  maxItems,
  uniqueItems: true,
  items: { type: "string", enum: [...values] },
});

const actions = ["view", "operate", "rotate", "administer", "audit"] as const;
const classifications = ["internal", "confidential", "restricted"] as const;
const products = [
  "process_chains",
  "bw_vendor",
  "s4_master",
  "bobj",
  "es_logs",
  "customers",
  "transactions",
  "events",
  "inventory",
  "tickets",
  "telemetry",
] as const;
const tenants = ["ACME", "GLOBEX", "NOVA", "HELIOS", "ATLAS"] as const;
const regions = ["NA", "EU", "APAC", "LATAM"] as const;
const departments = ["sales", "finance", "ops", "support", "engineering"] as const;
const sources = ["sap", "generic"] as const;
const masks = [
  "email",
  "account_number",
  "payload",
  "vendor_id",
  "bank_account",
  "legal_name",
] as const;

export const bearerHeadersSchema = {
  type: "object",
  required: ["authorization"],
  properties: {
    authorization: { type: "string", pattern: "^Bearer\\s+\\S+$", maxLength: 8192 },
  },
} as const;

export const idParamsSchema = (name: string) => ({
  type: "object",
  required: [name],
  additionalProperties: false,
  properties: { [name]: id },
});

export const membershipParamsSchema = {
  type: "object",
  required: ["capsuleId", "principalId"],
  additionalProperties: false,
  properties: { capsuleId: id, principalId: id },
} as const;

export const purposeQuerySchema = {
  type: "object",
  required: ["purpose"],
  additionalProperties: false,
  properties: { purpose: shortText },
} as const;

export const warehousePageQuerySchema = {
  type: "object",
  required: ["purpose"],
  additionalProperties: false,
  properties: {
    purpose: shortText,
    cursor: { type: "integer", minimum: 0, default: 0 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  },
} as const;

export const loginBodySchema = {
  type: "object",
  required: ["username", "password"],
  additionalProperties: false,
  properties: {
    username: id,
    password: { type: "string", minLength: 1, maxLength: 1024 },
  },
} as const;

export const pdpCheckBodySchema = {
  type: "object",
  required: ["action", "datasetId", "purpose"],
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: [...actions] },
    datasetId: id,
    recordId: id,
    purpose: shortText,
    principalId: id,
  },
} as const;

export const authzenEvaluationBodySchema = {
  type: "object",
  required: ["subject", "action", "resource", "context"],
  additionalProperties: false,
  properties: {
    subject: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id, type: { type: "string", enum: ["user", "workload"] } },
    },
    action: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: { name: { type: "string", enum: [...actions] } },
    },
    resource: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id, type: { type: "string", enum: ["dataset"] } },
    },
    context: {
      type: "object",
      required: ["purpose"],
      additionalProperties: false,
      properties: { purpose: shortText, recordId: id },
    },
  },
} as const;

export const offboardBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: { cascade: { type: "boolean" } },
} as const;

export const membershipBodySchema = {
  type: "object",
  required: ["principalId"],
  additionalProperties: false,
  properties: { principalId: id },
} as const;

export const jitRequestBodySchema = {
  type: "object",
  required: ["datasetId", "capsuleId", "purpose", "justification", "durationMs"],
  additionalProperties: false,
  properties: {
    datasetId: id,
    capsuleId: id,
    purpose: shortText,
    contractId: id,
    actions: stringList(actions),
    justification: { type: "string", minLength: 10, maxLength: 1000, pattern: "\\S" },
    durationMs: { type: "integer", minimum: 1_000, maximum: 28_800_000 },
    ticket: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
  },
} as const;

export const jitRevokeBodySchema = {
  type: "object",
  required: ["reason"],
  additionalProperties: false,
  properties: {
    reason: { type: "string", minLength: 3, maxLength: 500, pattern: "\\S" },
  },
} as const;

export const jitApproveBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ttlMs: { type: "integer", minimum: 1_000, maximum: 28_800_000 },
  },
} as const;

export const roleDraftSchema = {
  type: "object",
  required: [
    "name",
    "verbs",
    "purpose",
    "ceiling",
    "products",
    "tenants",
    "regions",
    "departments",
    "denyFields",
    "sources",
  ],
  additionalProperties: false,
  properties: {
    name: shortText,
    verbs: stringList(actions),
    purpose: shortText,
    ceiling: { type: "string", enum: [...classifications] },
    products: stringList(products),
    tenants: stringList(tenants),
    regions: stringList(regions),
    departments: stringList(departments),
    denyFields: stringList(masks),
    sources: stringList(sources),
  },
} as const;

export const roleDraftBodySchema = {
  type: "object",
  required: ["draft"],
  additionalProperties: false,
  properties: { draft: roleDraftSchema, principalId: id },
} as const;

export const roleApplyBodySchema = {
  type: "object",
  required: ["draft", "principalId"],
  additionalProperties: false,
  properties: { draft: roleDraftSchema, principalId: id },
} as const;

export const roleRequestBodySchema = {
  type: "object",
  required: ["draft"],
  additionalProperties: false,
  properties: { draft: roleDraftSchema, principalId: id },
} as const;

export const roleRequestDecisionBodySchema = {
  type: "object",
  required: ["reason"],
  additionalProperties: false,
  properties: {
    reason: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" },
  },
} as const;

export const sodViolationsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    principalId: id,
    cursor: { type: "integer", minimum: 0, default: 0 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
  },
} as const;

export const recertificationListQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["active", "completed", "expired"] },
    cursor: { type: "integer", minimum: 0, default: 0 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
  },
} as const;

export const recertificationItemsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["pending", "attested", "revoked", "removed"] },
    cursor: { type: "integer", minimum: 0, default: 0 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
  },
} as const;

export const recertificationCreateBodySchema = {
  type: "object",
  required: ["name", "dueAt", "cadenceDays"],
  additionalProperties: false,
  properties: {
    name: shortText,
    dueAt: { type: "integer", minimum: 1 },
    cadenceDays: { type: "integer", minimum: 1, maximum: 365 },
  },
} as const;

export const recertificationDecisionBodySchema = {
  type: "object",
  required: ["reason"],
  additionalProperties: false,
  properties: {
    reason: { type: "string", minLength: 3, maxLength: 500, pattern: "\\S" },
  },
} as const;

export const recertificationItemParamsSchema = {
  type: "object",
  required: ["campaignId", "itemId"],
  additionalProperties: false,
  properties: { campaignId: id, itemId: id },
} as const;

export const askBodySchema = {
  type: "object",
  required: ["ask"],
  additionalProperties: false,
  properties: {
    ask: { type: "string", minLength: 3, maxLength: 1000, pattern: "\\S" },
  },
} as const;

export const emptyBodySchema = {
  type: "object",
  maxProperties: 0,
  additionalProperties: false,
} as const;

export const paginationQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
    cursor: { type: "integer", minimum: 0, default: 0 },
  },
} as const;
