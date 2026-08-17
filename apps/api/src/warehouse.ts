import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  CLASS_RANK,
  WAREHOUSE_ALLOWED_FIELDS,
  canonicalFieldPaths,
  compileScopeToSql,
  orSqlFilters,
  projectAttrs,
  type Classification,
  type DataScope,
  type SqlFilter,
} from "@cca/core";
import {
  assertExistingSqliteFile,
  prepareWritableSqlitePath,
  restrictNewSqliteFiles,
} from "./sqlite-files.js";

const SCHEMA_VERSION = "5";
const LEGACY_UNIFIED_DATA_STORE = "CCA Unified Data Store";
export const UNIFIED_DATA_STORE = "PurposeMesh Unified Data Store";
const TENANTS = ["ACME", "GLOBEX", "NOVA", "HELIOS", "ATLAS"];
const REGIONS = ["NA", "EU", "APAC", "LATAM"];
const DEPARTMENTS = ["sales", "finance", "ops", "support", "engineering"];

export type WarehousePipeline = {
  id: string;
  name: string;
  sourceSystem: string;
  targetSystem: string;
  source: "sap" | "generic";
  products: readonly string[];
};

export const WAREHOUSE_PIPELINES = [
  {
    id: "sap-s4-bw-vendor",
    name: "S/4 Vendor → SAP BW → Unified Store",
    sourceSystem: "SAP S/4HANA",
    targetSystem: UNIFIED_DATA_STORE,
    source: "sap",
    products: ["s4_master", "bw_vendor", "process_chains"],
  },
  {
    id: "sap-bw-elastic-ops",
    name: "SAP BW → Elasticsearch → Unified Store",
    sourceSystem: "SAP BW",
    targetSystem: UNIFIED_DATA_STORE,
    source: "sap",
    products: ["es_logs", "events", "telemetry"],
  },
  {
    id: "azure-adf-business-load",
    name: "ADF Business Data → Unified Store",
    sourceSystem: "Azure Data Factory",
    targetSystem: UNIFIED_DATA_STORE,
    source: "generic",
    products: ["customers", "transactions", "inventory"],
  },
  {
    id: "sap-bobj-report-refresh",
    name: "BusinessObjects Refresh → Unified Store",
    sourceSystem: "SAP BusinessObjects",
    targetSystem: UNIFIED_DATA_STORE,
    source: "sap",
    products: ["bobj", "tickets"],
  },
] as const satisfies readonly WarehousePipeline[];

export type FactRow = {
  id: number;
  pipeline_id: string;
  pipeline_name: string;
  source_system: string;
  target_system: string;
  product: string;
  tenant: string;
  region: string;
  department: string;
  sensitivity: string;
  amount: number;
  occurred_at: string;
  email?: string;
  account_number?: string;
  payload?: string;
  title: string;
  status: string;
  source: string;
  vendor_id?: string;
  bank_account?: string;
  legal_name?: string;
};

export type DashboardQuery = {
  total: number;
  visible: number;
  byProduct: { key: string; count: number; amount?: number }[];
  byRegion: { key: string; count: number }[];
  byDepartment: { key: string; count: number }[];
  bySensitivity: { key: string; count: number }[];
  byDay: { key: string; count: number }[];
  sample: Partial<FactRow>[];
  denied: boolean;
};

export type WarehouseFacet = { key: string; count: number };

export type WarehousePage = {
  visible: number;
  records: Partial<FactRow>[];
  nextCursor?: number;
  fields: string[];
  facets: {
    products: WarehouseFacet[];
    tenants: WarehouseFacet[];
    regions: WarehouseFacet[];
    departments: WarehouseFacet[];
    sensitivities: WarehouseFacet[];
    sources: WarehouseFacet[];
  };
  lineage: Array<{
    pipelineId: string;
    pipelineName: string;
    sourceSystem: string;
    targetSystem: string;
    count: number;
  }>;
  denied: boolean;
};

export class Warehouse {
  constructor(private readonly db: DatabaseSync) {}

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number };
    return Number(row.n);
  }

  query(
    filter: SqlFilter,
    allowedFields: readonly string[],
    denyFields: readonly string[] = [],
    limit = 40,
  ): DashboardQuery {
    const projectedFields = warehouseProjection(allowedFields, denyFields);
    if (projectedFields.length === 0) {
      return {
        total: 0,
        visible: 0,
        byProduct: [],
        byRegion: [],
        byDepartment: [],
        bySensitivity: [],
        byDay: [],
        sample: [],
        denied: true,
      };
    }
    const total = this.count();
    if (filter.sql === "1=0") {
      return {
        total,
        visible: 0,
        byProduct: [],
        byRegion: [],
        byDepartment: [],
        bySensitivity: [],
        byDay: [],
        sample: [],
        denied: true,
      };
    }
    const params = filter.params as SQLInputValue[];
    const visible = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE ${filter.sql}`).get(...params) as { n: number }).n,
    );
    const projected = new Set(projectedFields);
    const byProduct = projected.has("product")
      ? this.db
          .prepare(projected.has("amount")
            ? `SELECT product AS key, COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount FROM facts WHERE ${filter.sql} GROUP BY product ORDER BY count DESC`
            : `SELECT product AS key, COUNT(*) AS count FROM facts WHERE ${filter.sql} GROUP BY product ORDER BY count DESC`)
          .all(...params) as DashboardQuery["byProduct"]
      : [];
    const byRegion = projected.has("region")
      ? this.db
          .prepare(`SELECT region AS key, COUNT(*) AS count FROM facts WHERE ${filter.sql} GROUP BY region ORDER BY count DESC`)
          .all(...params) as DashboardQuery["byRegion"]
      : [];
    const byDepartment = projected.has("department")
      ? this.db
          .prepare(`SELECT department AS key, COUNT(*) AS count FROM facts WHERE ${filter.sql} GROUP BY department ORDER BY count DESC`)
          .all(...params) as DashboardQuery["byDepartment"]
      : [];
    const bySensitivity = projected.has("sensitivity")
      ? this.db
          .prepare(`SELECT sensitivity AS key, COUNT(*) AS count FROM facts WHERE ${filter.sql} GROUP BY sensitivity ORDER BY count DESC`)
          .all(...params) as DashboardQuery["bySensitivity"]
      : [];
    const byDay = projected.has("occurred_at")
      ? this.db
          .prepare(`SELECT substr(occurred_at, 1, 10) AS key, COUNT(*) AS count FROM facts WHERE ${filter.sql} GROUP BY key ORDER BY key`)
          .all(...params) as DashboardQuery["byDay"]
      : [];
    const selectList = projectedFields.map((field) => `"${field}"`).join(", ");
    const sample = (
      this.db
        .prepare(`SELECT ${selectList} FROM facts WHERE ${filter.sql} ORDER BY id LIMIT ?`)
        .all(...params, limit) as Array<Record<string, unknown>>
    ).map((row) => projectFact(row, projectedFields, denyFields));
    return {
      total,
      visible,
      byProduct,
      byRegion,
      byDepartment,
      bySensitivity,
      byDay,
      sample,
      denied: false,
    };
  }

  page(
    filter: SqlFilter,
    allowedFields: readonly string[],
    denyFields: readonly string[] = [],
    cursor = 0,
    limit = 50,
  ): WarehousePage {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("warehouse cursor must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("warehouse limit must be between 1 and 100");
    const projectedFields = warehouseProjection(allowedFields, denyFields);
    if (projectedFields.length === 0 || filter.sql === "1=0") {
      return emptyWarehousePage(projectedFields);
    }

    const params = filter.params as SQLInputValue[];
    const visible = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE ${filter.sql}`).get(...params) as { n: number }).n,
    );
    const projected = new Set(projectedFields);
    const facet = (field: string): WarehouseFacet[] => {
      if (!projected.has(field)) return [];
      return (this.db
        .prepare(`SELECT "${field}" AS key, COUNT(*) AS count FROM facts WHERE ${filter.sql} GROUP BY "${field}" ORDER BY count DESC, key`)
        .all(...params) as Array<{ key: string; count: number }>)
        .map((item) => ({ key: item.key, count: Number(item.count) }));
    };

    const lineageFields = ["pipeline_id", "pipeline_name", "source_system", "target_system"];
    const lineage = lineageFields.every((field) => projected.has(field))
      ? (this.db.prepare(`
          SELECT pipeline_id, pipeline_name, source_system, target_system, COUNT(*) AS count
          FROM facts
          WHERE ${filter.sql}
          GROUP BY pipeline_id, pipeline_name, source_system, target_system
          ORDER BY count DESC, pipeline_id
        `).all(...params) as Array<{
          pipeline_id: string;
          pipeline_name: string;
          source_system: string;
          target_system: string;
          count: number;
        }>).map((item) => ({
          pipelineId: item.pipeline_id,
          pipelineName: item.pipeline_name,
          sourceSystem: item.source_system,
          targetSystem: publicTargetSystem(item.target_system),
          count: Number(item.count),
        }))
      : [];

    const selectedFields = projected.has("id") ? projectedFields : ["id", ...projectedFields];
    const selectList = selectedFields.map((field) => `"${field}"`).join(", ");
    const selected = this.db
      .prepare(`SELECT ${selectList} FROM facts WHERE (${filter.sql}) AND id > ? ORDER BY id LIMIT ?`)
      .all(...params, cursor, limit + 1) as Array<Record<string, unknown>>;
    const hasMore = selected.length > limit;
    const pageRows = hasMore ? selected.slice(0, limit) : selected;
    const nextCursor = hasMore && pageRows.length > 0 ? Number(pageRows.at(-1)!.id) : undefined;
    const records = pageRows.map((row) => projectFact(row, projectedFields, denyFields));

    return {
      visible,
      records,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      fields: projectedFields,
      facets: {
        products: facet("product"),
        tenants: facet("tenant"),
        regions: facet("region"),
        departments: facet("department"),
        sensitivities: facet("sensitivity"),
        sources: facet("source"),
      },
      lineage,
      denied: false,
    };
  }

  close(): void {
    this.db.close();
  }
}

function emptyWarehousePage(fields: string[] = []): WarehousePage {
  return {
    visible: 0,
    records: [],
    fields,
    facets: {
      products: [],
      tenants: [],
      regions: [],
      departments: [],
      sensitivities: [],
      sources: [],
    },
    lineage: [],
    denied: true,
  };
}

export function scopesToFilter(scopes: DataScope[]): SqlFilter {
  return orSqlFilters(scopes.map((scope) => compileScopeToSql(scope)));
}

function warehouseProjection(allowedFields: readonly string[], denyFields: readonly string[]): string[] {
  const canonical = canonicalFieldPaths(allowedFields);
  if (!canonical || canonical.length === 0) return [];
  const known = new Set<string>(WAREHOUSE_ALLOWED_FIELDS);
  if (canonical.some((field) => !known.has(field))) return [];
  return canonical.filter((field) => !denyFields.some(
    (denied) => denied === field || denied.startsWith(`${field}.`) || field.startsWith(`${denied}.`),
  ));
}

function projectFact(
  row: Record<string, unknown>,
  allowedFields: readonly string[],
  denyFields: readonly string[],
): Partial<FactRow> {
  const projected = projectAttrs(row, { allowedFields, denyFields }) as Partial<FactRow>;
  if (projected.target_system !== LEGACY_UNIFIED_DATA_STORE) return projected;
  return { ...projected, target_system: UNIFIED_DATA_STORE };
}

function publicTargetSystem(targetSystem: string): string {
  return targetSystem === LEGACY_UNIFIED_DATA_STORE ? UNIFIED_DATA_STORE : targetSystem;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

export function openWarehouse(opts: { path: string; rows: number; readOnly?: boolean }): Warehouse {
  if (opts.readOnly) {
    assertExistingSqliteFile(opts.path);
    const db = new DatabaseSync(opts.path, { readOnly: true });
    try {
      db.exec("PRAGMA query_only = ON");
      assertWarehouseSchema(db);
      return new Warehouse(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  const { created } = prepareWritableSqlitePath(opts.path);
  const db = new DatabaseSync(opts.path);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    restrictNewSqliteFiles(opts.path, created);
    db.exec("PRAGMA synchronous = OFF");
    db.exec(`
      CREATE TABLE IF NOT EXISTS warehouse_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY,
        pipeline_id TEXT NOT NULL,
        pipeline_name TEXT NOT NULL,
        source_system TEXT NOT NULL,
        target_system TEXT NOT NULL,
        product TEXT NOT NULL,
        tenant TEXT NOT NULL,
        region TEXT NOT NULL,
        department TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        class_rank INTEGER NOT NULL,
        amount REAL NOT NULL,
        occurred_at TEXT NOT NULL,
        email TEXT,
        account_number TEXT,
        payload TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        vendor_id TEXT,
        bank_account TEXT,
        legal_name TEXT
      )
    `);
    const versionRow = db.prepare("SELECT value FROM warehouse_meta WHERE key = 'schema'").get() as
      | { value: string }
      | undefined;
    const existing = Number((db.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n);
    const needsSeed = versionRow?.value !== SCHEMA_VERSION || existing < opts.rows;
    if (needsSeed) {
      db.exec("DROP TABLE IF EXISTS facts");
      db.exec(`
        CREATE TABLE facts (
          id INTEGER PRIMARY KEY,
          pipeline_id TEXT NOT NULL,
          pipeline_name TEXT NOT NULL,
          source_system TEXT NOT NULL,
          target_system TEXT NOT NULL,
          product TEXT NOT NULL,
          tenant TEXT NOT NULL,
          region TEXT NOT NULL,
          department TEXT NOT NULL,
          sensitivity TEXT NOT NULL,
          class_rank INTEGER NOT NULL,
          amount REAL NOT NULL,
          occurred_at TEXT NOT NULL,
          email TEXT,
          account_number TEXT,
          payload TEXT,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          vendor_id TEXT,
          bank_account TEXT,
          legal_name TEXT
        )
      `);
      seedFacts(db, opts.rows);
      db.exec("CREATE INDEX IF NOT EXISTS idx_facts_pipeline ON facts(pipeline_id, id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_facts_product ON facts(product)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_facts_tenant ON facts(tenant)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_facts_region ON facts(region)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_facts_class ON facts(class_rank)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_facts_day ON facts(occurred_at)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(product, source, tenant, class_rank, id)");
      db.prepare("INSERT OR REPLACE INTO warehouse_meta(key, value) VALUES ('schema', ?)").run(SCHEMA_VERSION);
    }
    db.exec("PRAGMA synchronous = NORMAL");
    restrictNewSqliteFiles(opts.path, created);
    return new Warehouse(db);
  } catch (error) {
    db.close();
    throw error;
  }
}

function assertWarehouseSchema(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'facts'")
    .get() as { name: string } | undefined;
  if (!table) throw new Error("production warehouse is missing the facts table");
  const requiredColumns = new Set<string>([...WAREHOUSE_ALLOWED_FIELDS, "class_rank"]);
  const columns = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  for (const column of columns) requiredColumns.delete(column.name);
  if (requiredColumns.size > 0) {
    throw new Error(`production warehouse is missing required columns: ${[...requiredColumns].join(", ")}`);
  }
  db.prepare("SELECT COUNT(*) AS n FROM facts").get();
}

function seedFacts(db: DatabaseSync, rows: number): void {
  const rand = mulberry32(20260815);
  const insert = db.prepare(`
    INSERT INTO facts (
      id, pipeline_id, pipeline_name, source_system, target_system,
      product, tenant, region, department, sensitivity, class_rank,
      amount, occurred_at, email, account_number, payload, title, status,
      source, vendor_id, bank_account, legal_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec("BEGIN");
  for (let id = 1; id <= rows; id++) {
    const pipeline = WAREHOUSE_PIPELINES[(id - 1) % WAREHOUSE_PIPELINES.length]!;
    const product = pick(rand, pipeline.products);
    const tenant = pick(rand, TENANTS);
    const region = pick(rand, REGIONS);
    const department = pick(rand, DEPARTMENTS);
    const roll = rand();
    let sensitivity: Classification = roll < 0.7 ? "internal" : roll < 0.92 ? "confidential" : "restricted";
    if (product === "process_chains") sensitivity = "internal";
    if (product === "s4_master") sensitivity = roll < 0.25 ? "confidential" : "restricted";
    const day = 1 + (id % 28);
    const occurred = `2026-07-${String(day).padStart(2, "0")}T${String(id % 24).padStart(2, "0")}:00:00Z`;
    insert.run(
      id,
      pipeline.id,
      pipeline.name,
      pipeline.sourceSystem,
      pipeline.targetSystem,
      product,
      tenant,
      region,
      department,
      sensitivity,
      CLASS_RANK[sensitivity],
      Math.round((50 + rand() * 5000) * 100) / 100,
      occurred,
      `${product}.${id}@${tenant.toLowerCase()}.example`,
      `ACCT-${100000 + (id % 900000)}`,
      `payload-${id}`,
      `${product} #${id}`,
      pick(rand, ["open", "closed", "pending", "failed"]),
      pipeline.source,
      `V${String(1000 + (id % 4000))}`,
      `BANK-${id}`,
      `${tenant} ${product} legal`,
    );
  }
  db.exec("COMMIT");
}
