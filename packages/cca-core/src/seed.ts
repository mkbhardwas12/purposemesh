import { hashPassword } from "./crypto.js";
import { ALL_WAREHOUSE_PRODUCTS, WAREHOUSE_ALLOWED_FIELDS } from "./role-draft.js";
import { CcaStore } from "./store.js";
import type { Persona } from "./types.js";

const fieldsExcept = (...excluded: string[]) =>
  WAREHOUSE_ALLOWED_FIELDS.filter((field) => !excluded.includes(field));

const L1_DENY_FIELDS = ["email", "account_number", "payload", "vendor_id", "bank_account", "legal_name"];
const L2_BW_DENY_FIELDS = ["email", "account_number", "payload", "bank_account", "legal_name"];
const L2_BOBJ_DENY_FIELDS = ["email", "account_number", "payload", "bank_account", "legal_name"];
const OBS_DENY_FIELDS = ["email", "account_number", "payload", "bank_account", "legal_name"];
const CONSUMER_DENY_FIELDS = ["email", "account_number", "payload", "bank_account", "legal_name"];

const personas: Persona[] = [
  { id: "l1", label: "L1 Support", actions: ["view"], ceiling: "internal" },
  {
    id: "l2bw",
    label: "L2 BW",
    actions: ["view", "operate"],
    ceiling: "confidential",
  },
  {
    id: "l2bobj",
    label: "L2 BOBJ",
    actions: ["view", "operate"],
    ceiling: "confidential",
  },
  {
    id: "obs",
    label: "Pipeline / ES Ops",
    actions: ["view", "operate", "rotate"],
    ceiling: "internal",
  },
  { id: "consumer", label: "Business consumer", actions: ["view"], ceiling: "confidential" },
  {
    id: "steward",
    label: "Data steward",
    actions: ["view", "administer"],
    ceiling: "confidential",
  },
  {
    id: "data-owner",
    label: "Data Owner",
    actions: ["view", "audit"],
    ceiling: "restricted",
  },
  {
    id: "admin",
    label: "Platform admin",
    actions: ["administer", "audit", "rotate"],
    ceiling: "none",
  },
  {
    id: "pipeline",
    label: "Replication workload",
    actions: ["view", "operate"],
    ceiling: "restricted",
  },
];

export function seedStore(): CcaStore {
  const store = new CcaStore();
  for (const persona of personas) {
    store.personas.set(persona.id, { ...persona, actions: [...persona.actions] });
  }

  const capsules = [
    {
      id: "support-l1",
      label: "Support L1",
      purpose: "incident-triage",
      attrs: { products: ["events", "tickets", "process_chains"], sources: ["sap", "generic"] },
    },
    {
      id: "support-l2-bw",
      label: "Support L2 BW",
      purpose: "replication-repair",
      attrs: {
        products: ["events", "transactions", "telemetry", "process_chains", "bw_vendor"],
        sources: ["sap", "generic"],
        vendor_set: ["V1001", "V1002"],
      },
    },
    {
      id: "support-l2-bobj",
      label: "Support L2 BOBJ",
      purpose: "report-repair",
      attrs: { products: ["tickets", "bobj"], sources: ["sap", "generic"] },
    },
    {
      id: "platform-obs",
      label: "Platform observability",
      purpose: "pipeline-reliability",
      attrs: { products: ["events", "telemetry", "es_logs"], sources: ["sap", "generic"] },
    },
    { id: "vendor-domain", label: "Vendor domain", purpose: "vendor-governance", attrs: {} },
    {
      id: "vendor-acme",
      label: "Vendor ACME",
      purpose: "vendor-performance",
      parentId: "vendor-domain",
      attrs: {
        vendor_set: ["V1001", "V1002", "ACME"],
        tenants: ["ACME"],
        products: ["customers", "transactions", "inventory", "bw_vendor"],
        sources: ["sap", "generic"],
      },
    },
    {
      id: "vendor-globex",
      label: "Vendor Globex",
      purpose: "vendor-performance",
      parentId: "vendor-domain",
      attrs: {
        vendor_set: ["V2001", "V2002", "GLOBEX"],
        tenants: ["GLOBEX"],
        products: ["customers", "transactions", "inventory", "bw_vendor"],
        sources: ["sap", "generic"],
      },
    },
    {
      id: "data-governance-owner",
      label: "Unified data governance",
      purpose: "data-governance",
      attrs: {
        products: [...ALL_WAREHOUSE_PRODUCTS],
        sources: ["sap", "generic"],
      },
    },
    { id: "control-plane", label: "Control plane", purpose: "governance", attrs: {} },
    { id: "pipeline-replicate", label: "S/4 extract → BW stage", purpose: "replication", attrs: {} },
    { id: "pipeline-bw-activate", label: "BW stage → governed provider", purpose: "replication", attrs: {} },
    { id: "pipeline-es-publish", label: "BW chain → sanitized ES telemetry", purpose: "replication", attrs: {} },
  ] as const;

  for (const capsule of capsules) {
    store.capsules.set(capsule.id, { ...capsule, active: true, attrs: { ...capsule.attrs } });
  }

  const humans = [
    ["ana.l1", "Ana Cole", "l1"],
    ["ben.l2bw", "Ben Walsh", "l2bw"],
    ["cara.l2bobj", "Cara Nguyen", "l2bobj"],
    ["dev.obs", "Dev Okonkwo", "obs"],
    ["emma.acme", "Emma Patel", "consumer"],
    ["finn.globex", "Finn Okafor", "consumer"],
    ["gita.steward", "Gita Shah", "steward"],
    ["dana.owner", "Dana Morgan", "data-owner"],
    ["hugo.admin", "Hugo Meyer", "admin"],
    ["iris.admin", "Iris Chen", "admin"],
  ] as const;

  for (const [username, displayName, personaId] of humans) {
    store.principals.set(username, {
      id: username,
      username,
      displayName,
      passwordHash: hashPassword("cca-demo"),
      personaId,
      kind: "human",
      disabled: false,
    });
  }
  store.principals.set("pc.vendor.replicate", {
    id: "pc.vendor.replicate",
    username: "pc.vendor.replicate",
    displayName: "BW process chain PC_VENDOR_REPL",
    passwordHash: hashPassword("cca-demo"),
    personaId: "pipeline",
    kind: "workload",
    disabled: false,
  });
  store.principals.set("pc.vendor.activate", {
    id: "pc.vendor.activate",
    username: "pc.vendor.activate",
    displayName: "BW activation workload PC_VENDOR_ACTIVATE",
    passwordHash: hashPassword("cca-demo"),
    personaId: "pipeline",
    kind: "workload",
    disabled: false,
  });
  store.principals.set("pc.vendor.telemetry", {
    id: "pc.vendor.telemetry",
    username: "pc.vendor.telemetry",
    displayName: "Sanitized pipeline telemetry publisher",
    passwordHash: hashPassword("cca-demo"),
    personaId: "pipeline",
    kind: "workload",
    disabled: false,
  });

  store.memberships = [
    { principalId: "ana.l1", capsuleId: "support-l1", personaId: "l1" },
    { principalId: "ben.l2bw", capsuleId: "support-l2-bw", personaId: "l2bw" },
    { principalId: "cara.l2bobj", capsuleId: "support-l2-bobj", personaId: "l2bobj" },
    { principalId: "dev.obs", capsuleId: "platform-obs", personaId: "obs" },
    { principalId: "emma.acme", capsuleId: "vendor-acme", personaId: "consumer" },
    { principalId: "finn.globex", capsuleId: "vendor-globex", personaId: "consumer" },
    { principalId: "gita.steward", capsuleId: "vendor-acme", personaId: "steward" },
    { principalId: "dana.owner", capsuleId: "data-governance-owner", personaId: "data-owner" },
    { principalId: "hugo.admin", capsuleId: "control-plane", personaId: "admin" },
    { principalId: "iris.admin", capsuleId: "control-plane", personaId: "admin" },
    { principalId: "pc.vendor.replicate", capsuleId: "pipeline-replicate", personaId: "pipeline" },
    { principalId: "pc.vendor.activate", capsuleId: "pipeline-bw-activate", personaId: "pipeline" },
    { principalId: "pc.vendor.telemetry", capsuleId: "pipeline-es-publish", personaId: "pipeline" },
  ].map((membership, index) => ({
    ...membership,
    assignmentId: `seed-assignment-${String(index + 1).padStart(2, "0")}`,
  }));

  const datasets = [
    {
      id: "sla",
      name: "L1 SLA / chain health",
      origin: "BW + ADF aggregates",
      design: "Operational metrics",
      classification: "internal" as const,
      controlPlane: false,
      allowedFields: ["chain", "sla", "lag_seconds"],
    },
    {
      id: "pc_status",
      name: "Process chain status",
      origin: "SAP BW RSPC",
      design: "Event log",
      classification: "internal" as const,
      controlPlane: false,
      allowedFields: ["chain", "status", "vendor_id", "finished_at"],
    },
    {
      id: "pc_detail",
      name: "Process chain detail + dumps",
      origin: "SAP BW process chain",
      design: "Ops diagnostic",
      classification: "confidential" as const,
      controlPlane: false,
      allowedFields: ["chain", "vendor_id", "error_dump", "payload.raw"],
    },
    {
      id: "bw_vendor",
      name: "BW vendor analytics",
      origin: "S/4 replicated into BW",
      design: "Dimensional InfoProvider",
      classification: "confidential" as const,
      controlPlane: false,
      allowedFields: ["vendor_id", "vendor_name", "spend", "region"],
    },
    {
      id: "bw_vendor_stage",
      name: "BW vendor replication staging",
      origin: "S/4 extraction landing in BW",
      design: "Restricted activation stage",
      classification: "restricted" as const,
      controlPlane: false,
      allowedFields: ["vendor_id", "company_code", "source_timestamp", "payload.raw"],
    },
    {
      id: "s4_vendor",
      name: "S/4 vendor master",
      origin: "S/4HANA",
      design: "Master data",
      classification: "restricted" as const,
      controlPlane: false,
      allowedFields: ["vendor_id", "legal_name", "bank_account", "tax_id"],
    },
    {
      id: "bobj",
      name: "BOBJ universe / report ops",
      origin: "SAP BOBJ CMC",
      design: "Semantic layer",
      classification: "confidential" as const,
      controlPlane: false,
      allowedFields: ["report", "status", "universe"],
    },
    {
      id: "es_tech",
      name: "Elasticsearch pipeline logs (technical)",
      origin: "Shared ES cluster",
      design: "Append-only documents",
      classification: "internal" as const,
      controlPlane: false,
      allowedFields: ["level", "message", "process_chain_id", "payload.vendor_id", "payload.raw"],
    },
    {
      id: "es_payload",
      name: "ES logs — S/4 payload fields",
      origin: "Same ES documents",
      design: "Restricted field group",
      classification: "restricted" as const,
      controlPlane: false,
      allowedFields: ["vendor_id", "payload.raw", "bank_account"],
    },
    {
      id: "audit",
      name: "Access and policy audit",
      origin: "PDP decision log",
      design: "Hash-chained events",
      classification: "confidential" as const,
      controlPlane: true,
      allowedFields: ["seq", "at", "actorId", "type", "prevHash", "hash"],
    },
    {
      id: "warehouse",
      name: "Unified synthetic pipeline warehouse",
      origin: "Deterministic SAP, ADF, Elasticsearch, BOBJ, and shared-data pipelines",
      design: "One governed fact table with named pipeline lineage, business dimensions, and protected fields",
      classification: "restricted" as const,
      controlPlane: false,
      allowedFields: [...WAREHOUSE_ALLOWED_FIELDS],
      ownerPrincipalIds: ["dana.owner"],
    },
  ];
  for (const dataset of datasets) store.datasets.set(dataset.id, dataset);

  const contracts = [
    {
      id: "health.sla",
      datasetId: "sla",
      purpose: "incident-triage",
      allowedPersonas: ["l1", "l2bw", "l2bobj", "obs"] as const,
      actions: ["view"] as const,
      classificationMax: "internal" as const,
      predicate: { op: "true" as const },
      denyFields: [],
    },
    {
      id: "pc.status-summary",
      datasetId: "pc_status",
      purpose: "incident-triage",
      allowedPersonas: ["l1", "l2bw", "obs"] as const,
      actions: ["view"] as const,
      classificationMax: "internal" as const,
      predicate: { op: "true" as const },
      denyFields: ["vendor_id"],
    },
    {
      id: "pc.ops-full",
      datasetId: "pc_detail",
      purpose: "replication-repair",
      allowedPersonas: ["l2bw"] as const,
      actions: ["view", "operate"] as const,
      classificationMax: "confidential" as const,
      predicate: { op: "true" as const },
      denyFields: ["payload"],
    },
    {
      id: "pc.ops-masked",
      datasetId: "pc_detail",
      purpose: "pipeline-reliability",
      allowedPersonas: ["obs"] as const,
      actions: ["view"] as const,
      classificationMax: "internal" as const,
      predicate: { op: "true" as const },
      denyFields: ["vendor_id", "payload", "error_dump"],
    },
    {
      id: "bobj.ops",
      datasetId: "bobj",
      purpose: "report-repair",
      allowedPersonas: ["l2bobj"] as const,
      actions: ["view", "operate"] as const,
      classificationMax: "confidential" as const,
      predicate: { op: "true" as const },
      denyFields: [],
    },
    {
      id: "es.pipeline-tech",
      datasetId: "es_tech",
      purpose: "pipeline-reliability",
      allowedPersonas: ["obs", "l2bw", "l2bobj"] as const,
      actions: ["view", "operate"] as const,
      classificationMax: "internal" as const,
      predicate: { op: "true" as const },
      denyFields: ["payload"],
    },
    {
      id: "vendor.acme.slice",
      datasetId: "bw_vendor",
      purpose: "vendor-performance",
      allowedPersonas: ["consumer", "steward"] as const,
      actions: ["view"] as const,
      classificationMax: "confidential" as const,
      predicate: { op: "fromCapsuleAttr" as const, field: "vendor_id", attr: "vendor_set" },
      denyFields: [],
    },
    {
      id: "vendor.globex.slice",
      datasetId: "bw_vendor",
      purpose: "vendor-performance",
      allowedPersonas: ["consumer", "steward"] as const,
      actions: ["view"] as const,
      classificationMax: "confidential" as const,
      predicate: { op: "fromCapsuleAttr" as const, field: "vendor_id", attr: "vendor_set" },
      denyFields: [],
    },
    {
      id: "jit.l2bw.vendor-diagnostics",
      datasetId: "bw_vendor",
      purpose: "replication-repair",
      allowedPersonas: ["l2bw"] as const,
      actions: ["view"] as const,
      classificationMax: "confidential" as const,
      predicate: { op: "fromCapsuleAttr" as const, field: "vendor_id", attr: "vendor_set" },
      allowFields: ["vendor_id", "vendor_name", "region"],
      denyFields: ["spend"],
      approvalRequired: true,
    },
    {
      id: "jit.vendor.bw-export",
      datasetId: "bw_vendor",
      purpose: "vendor-performance",
      allowedPersonas: ["consumer", "steward"] as const,
      actions: ["view"] as const,
      classificationMax: "confidential" as const,
      predicate: { op: "fromCapsuleAttr" as const, field: "vendor_id", attr: "vendor_set" },
      allowFields: ["vendor_id", "vendor_name", "region"],
      denyFields: ["spend"],
      approvalRequired: true,
    },
    {
      id: "pipeline.write-es",
      datasetId: "es_tech",
      purpose: "replication",
      allowedPersonas: ["pipeline"] as const,
      actions: ["view", "operate"] as const,
      classificationMax: "restricted" as const,
      predicate: { op: "true" as const },
      denyFields: [],
    },
    {
      id: "pipeline.read-s4",
      datasetId: "s4_vendor",
      purpose: "replication",
      allowedPersonas: ["pipeline"] as const,
      actions: ["view", "operate"] as const,
      classificationMax: "restricted" as const,
      predicate: { op: "true" as const },
      denyFields: [],
    },
    {
      id: "pipeline.write-bw-stage",
      datasetId: "bw_vendor_stage",
      purpose: "replication",
      allowedPersonas: ["pipeline"] as const,
      actions: ["operate"] as const,
      classificationMax: "restricted" as const,
      predicate: { op: "true" as const },
      denyFields: [],
    },
    {
      id: "pipeline.read-bw-stage",
      datasetId: "bw_vendor_stage",
      purpose: "replication",
      allowedPersonas: ["pipeline"] as const,
      actions: ["view"] as const,
      classificationMax: "restricted" as const,
      predicate: { op: "true" as const },
      denyFields: [],
    },
    {
      id: "pipeline.write-bw-provider",
      datasetId: "bw_vendor",
      purpose: "replication",
      allowedPersonas: ["pipeline"] as const,
      actions: ["operate"] as const,
      classificationMax: "confidential" as const,
      predicate: { op: "true" as const },
      denyFields: [],
    },
    {
      id: "pipeline.read-chain-status",
      datasetId: "pc_status",
      purpose: "replication",
      allowedPersonas: ["pipeline"] as const,
      actions: ["view"] as const,
      classificationMax: "internal" as const,
      predicate: { op: "true" as const },
      denyFields: ["vendor_id"],
    },
    {
      id: "wh.l1",
      datasetId: "warehouse",
      purpose: "support",
      allowedPersonas: ["l1"] as const,
      actions: ["view"] as const,
      classificationMax: "internal" as const,
      predicate: {
        op: "and" as const,
        clauses: [
          { op: "fromCapsuleAttr" as const, field: "product", attr: "products" },
          { op: "fromCapsuleAttr" as const, field: "source", attr: "sources" },
        ],
      },
      allowFields: fieldsExcept(...L1_DENY_FIELDS),
      denyFields: [...L1_DENY_FIELDS],
    },
    {
      id: "wh.l2bw",
      datasetId: "warehouse",
      purpose: "operations",
      allowedPersonas: ["l2bw"] as const,
      actions: ["view", "operate"] as const,
      classificationMax: "confidential" as const,
      predicate: {
        op: "and" as const,
        clauses: [
          { op: "fromCapsuleAttr" as const, field: "product", attr: "products" },
          { op: "fromCapsuleAttr" as const, field: "source", attr: "sources" },
        ],
      },
      allowFields: fieldsExcept(...L2_BW_DENY_FIELDS),
      denyFields: [...L2_BW_DENY_FIELDS],
    },
    {
      id: "wh.l2bobj",
      datasetId: "warehouse",
      purpose: "support",
      allowedPersonas: ["l2bobj"] as const,
      actions: ["view", "operate"] as const,
      classificationMax: "confidential" as const,
      predicate: {
        op: "and" as const,
        clauses: [
          { op: "fromCapsuleAttr" as const, field: "product", attr: "products" },
          { op: "fromCapsuleAttr" as const, field: "source", attr: "sources" },
        ],
      },
      allowFields: fieldsExcept(...L2_BOBJ_DENY_FIELDS),
      denyFields: [...L2_BOBJ_DENY_FIELDS],
    },
    {
      id: "wh.obs",
      datasetId: "warehouse",
      purpose: "operations",
      allowedPersonas: ["obs"] as const,
      actions: ["view", "operate"] as const,
      classificationMax: "internal" as const,
      predicate: {
        op: "and" as const,
        clauses: [
          { op: "fromCapsuleAttr" as const, field: "product", attr: "products" },
          { op: "fromCapsuleAttr" as const, field: "source", attr: "sources" },
        ],
      },
      allowFields: fieldsExcept(...OBS_DENY_FIELDS),
      denyFields: [...OBS_DENY_FIELDS],
    },
    {
      id: "wh.acme",
      datasetId: "warehouse",
      purpose: "analytics",
      allowedPersonas: ["consumer", "steward"] as const,
      actions: ["view"] as const,
      classificationMax: "confidential" as const,
      predicate: {
        op: "and" as const,
        clauses: [
          { op: "fromCapsuleAttr" as const, field: "product", attr: "products" },
          { op: "fromCapsuleAttr" as const, field: "tenant", attr: "tenants" },
          { op: "fromCapsuleAttr" as const, field: "source", attr: "sources" },
        ],
      },
      allowFields: fieldsExcept(...CONSUMER_DENY_FIELDS),
      denyFields: [...CONSUMER_DENY_FIELDS],
    },
    {
      id: "wh.globex",
      datasetId: "warehouse",
      purpose: "analytics",
      allowedPersonas: ["consumer", "steward"] as const,
      actions: ["view"] as const,
      classificationMax: "confidential" as const,
      predicate: {
        op: "and" as const,
        clauses: [
          { op: "fromCapsuleAttr" as const, field: "product", attr: "products" },
          { op: "fromCapsuleAttr" as const, field: "tenant", attr: "tenants" },
          { op: "fromCapsuleAttr" as const, field: "source", attr: "sources" },
        ],
      },
      allowFields: fieldsExcept(...CONSUMER_DENY_FIELDS),
      denyFields: [...CONSUMER_DENY_FIELDS],
    },
    {
      id: "wh.data-owner",
      datasetId: "warehouse",
      purpose: "data-governance",
      allowedPersonas: ["data-owner"] as const,
      actions: ["view"] as const,
      classificationMax: "restricted" as const,
      predicate: {
        op: "and" as const,
        clauses: [
          { op: "fromCapsuleAttr" as const, field: "product", attr: "products" },
          { op: "fromCapsuleAttr" as const, field: "source", attr: "sources" },
        ],
      },
      allowFields: [...WAREHOUSE_ALLOWED_FIELDS],
      denyFields: [],
    },
  ];

  for (const contract of contracts) {
    store.contracts.set(contract.id, {
      ...contract,
      allowedPersonas: [...contract.allowedPersonas],
      actions: [...contract.actions],
    });
  }

  store.bindings = [
    { id: "b1", capsuleId: "support-l1", contractId: "health.sla" },
    { id: "b2", capsuleId: "support-l1", contractId: "pc.status-summary" },
    { id: "b3", capsuleId: "support-l2-bw", contractId: "health.sla" },
    { id: "b4", capsuleId: "support-l2-bw", contractId: "pc.status-summary" },
    { id: "b5", capsuleId: "support-l2-bw", contractId: "pc.ops-full" },
    { id: "b6", capsuleId: "support-l2-bw", contractId: "es.pipeline-tech" },
    { id: "b7", capsuleId: "support-l2-bobj", contractId: "health.sla" },
    { id: "b8", capsuleId: "support-l2-bobj", contractId: "bobj.ops" },
    { id: "b9", capsuleId: "support-l2-bobj", contractId: "es.pipeline-tech" },
    { id: "b10", capsuleId: "platform-obs", contractId: "health.sla" },
    { id: "b11", capsuleId: "platform-obs", contractId: "pc.status-summary" },
    { id: "b12", capsuleId: "platform-obs", contractId: "pc.ops-masked" },
    { id: "b13", capsuleId: "platform-obs", contractId: "es.pipeline-tech" },
    { id: "b14", capsuleId: "vendor-acme", contractId: "vendor.acme.slice" },
    { id: "b15", capsuleId: "vendor-globex", contractId: "vendor.globex.slice" },
    { id: "b16", capsuleId: "pipeline-es-publish", contractId: "pipeline.write-es" },
    { id: "b17", capsuleId: "pipeline-replicate", contractId: "pipeline.read-s4" },
    { id: "b18", capsuleId: "support-l1", contractId: "wh.l1" },
    { id: "b19", capsuleId: "support-l2-bw", contractId: "wh.l2bw" },
    { id: "b20", capsuleId: "support-l2-bobj", contractId: "wh.l2bobj" },
    { id: "b21", capsuleId: "platform-obs", contractId: "wh.obs" },
    { id: "b22", capsuleId: "vendor-acme", contractId: "wh.acme" },
    { id: "b23", capsuleId: "vendor-globex", contractId: "wh.globex" },
    { id: "b24", capsuleId: "support-l2-bw", contractId: "jit.l2bw.vendor-diagnostics" },
    { id: "b25", capsuleId: "data-governance-owner", contractId: "wh.data-owner" },
    { id: "b26", capsuleId: "pipeline-replicate", contractId: "pipeline.write-bw-stage" },
    { id: "b27", capsuleId: "pipeline-bw-activate", contractId: "pipeline.read-bw-stage" },
    { id: "b28", capsuleId: "pipeline-bw-activate", contractId: "pipeline.write-bw-provider" },
    { id: "b29", capsuleId: "pipeline-es-publish", contractId: "pipeline.read-chain-status" },
    { id: "b30", capsuleId: "vendor-acme", contractId: "jit.vendor.bw-export" },
    { id: "b31", capsuleId: "vendor-globex", contractId: "jit.vendor.bw-export" },
  ];

  store.records = [
    {
      id: "sla-1",
      datasetId: "sla",
      classification: "internal",
      attrs: { chain: "PC_VENDOR_REPL", sla: "green", lag_seconds: 12 },
    },
    {
      id: "pc-1",
      datasetId: "pc_status",
      classification: "internal",
      attrs: { chain: "PC_VENDOR_REPL", status: "SUCCESS", vendor_id: "V1001", finished_at: "2026-08-15T10:02:00Z" },
    },
    {
      id: "pcd-1",
      datasetId: "pc_detail",
      classification: "confidential",
      attrs: {
        chain: "PC_VENDOR_REPL",
        vendor_id: "V1001",
        error_dump: "package 9001 duplicate key",
        payload: { raw: "s4-extract-row" },
      },
    },
    {
      id: "bw-1",
      datasetId: "bw_vendor",
      classification: "confidential",
      attrs: { vendor_id: "V1001", vendor_name: "ACME Logistics", spend: 1_200_000, region: "NA" },
    },
    {
      id: "bw-stage-1",
      datasetId: "bw_vendor_stage",
      classification: "restricted",
      attrs: {
        vendor_id: "V1001",
        company_code: "US01",
        source_timestamp: "2026-08-15T10:00:00Z",
        payload: { raw: "restricted-s4-stage-row" },
      },
    },
    {
      id: "bw-2",
      datasetId: "bw_vendor",
      classification: "confidential",
      attrs: { vendor_id: "V1002", vendor_name: "ACME Parts", spend: 440_000, region: "EU" },
    },
    {
      id: "bw-3",
      datasetId: "bw_vendor",
      classification: "confidential",
      attrs: { vendor_id: "V2001", vendor_name: "Globex Mining", spend: 980_000, region: "APAC" },
    },
    {
      id: "bw-4",
      datasetId: "bw_vendor",
      classification: "confidential",
      attrs: { vendor_id: "V2002", vendor_name: "Globex Fleet", spend: 210_000, region: "NA" },
    },
    {
      id: "s4-1",
      datasetId: "s4_vendor",
      classification: "restricted",
      attrs: {
        vendor_id: "V1001",
        legal_name: "ACME Logistics GmbH",
        bank_account: "DE12100000001234567890",
        tax_id: "DE-99-4411",
      },
    },
    {
      id: "s4-2",
      datasetId: "s4_vendor",
      classification: "restricted",
      attrs: {
        vendor_id: "V2001",
        legal_name: "Globex Mining Ltd",
        bank_account: "GB29NWBK60161331926819",
        tax_id: "GB-22-9188",
      },
    },
    {
      id: "bobj-1",
      datasetId: "bobj",
      classification: "confidential",
      attrs: { report: "Vendor Spend Q2", status: "FAILED", universe: "UNV_VENDOR" },
    },
    {
      id: "es-1",
      datasetId: "es_tech",
      classification: "internal",
      attrs: {
        level: "info",
        message: "extract ok",
        process_chain_id: "PC_VENDOR_REPL",
        payload: { vendor_id: "V1001", raw: "should-strip" },
      },
    },
    {
      id: "es-2",
      datasetId: "es_tech",
      classification: "internal",
      attrs: { level: "error", message: "bobj job timeout", process_chain_id: "BOBJ_REFRESH" },
    },
    {
      id: "esp-1",
      datasetId: "es_payload",
      classification: "restricted",
      attrs: { vendor_id: "V1001", payload: { raw: "s4-row-image" }, bank_account: "DE12100000001234567890" },
    },
  ];

  store.appendAudit("system", "store.seed", { principals: store.principals.size });
  return store;
}

export const DEMO_USERS = [
  { username: "ana.l1", persona: "L1 Support", capsule: "Support L1" },
  { username: "ben.l2bw", persona: "L2 BW", capsule: "Support L2 BW" },
  { username: "cara.l2bobj", persona: "L2 BOBJ", capsule: "Support L2 BOBJ" },
  { username: "dev.obs", persona: "Pipeline / ES Ops", capsule: "Platform observability" },
  { username: "emma.acme", persona: "Business consumer", capsule: "Vendor ACME" },
  { username: "finn.globex", persona: "Business consumer", capsule: "Vendor Globex" },
  { username: "gita.steward", persona: "Data steward", capsule: "Vendor ACME" },
  { username: "dana.owner", persona: "Data Owner", capsule: "Unified data governance" },
  { username: "hugo.admin", persona: "Platform admin", capsule: "Control plane" },
  { username: "iris.admin", persona: "Platform admin", capsule: "Control plane" },
] as const;
