import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ALL_WAREHOUSE_PRODUCTS, WAREHOUSE_ALLOWED_FIELDS } from "@cca/core";
import { describe, expect, it } from "vitest";
import { openWarehouse, UNIFIED_DATA_STORE } from "../src/warehouse.js";

describe("unified synthetic warehouse", () => {
  it("deterministically builds at least 100,000 rows across every named pipeline", () => {
    const directory = mkdtempSync(join(tmpdir(), "cca-unified-warehouse-test-"));
    const path = join(directory, "warehouse.sqlite");
    const warehouse = openWarehouse({ path, rows: 100_000 });
    try {
      expect(warehouse.count()).toBe(100_000);
      const page = warehouse.page(
        { sql: "1=1", params: [] },
        WAREHOUSE_ALLOWED_FIELDS,
        [],
        0,
        4,
      );
      expect(page.visible).toBe(100_000);
      expect(page.records.map((record) => record.pipeline_id)).toEqual([
        "sap-s4-bw-vendor",
        "sap-bw-elastic-ops",
        "azure-adf-business-load",
        "sap-bobj-report-refresh",
      ]);
      expect(page.records.map((record) => record.pipeline_name)).toEqual([
        "S/4 Vendor → SAP BW → Unified Store",
        "SAP BW → Elasticsearch → Unified Store",
        "ADF Business Data → Unified Store",
        "BusinessObjects Refresh → Unified Store",
      ]);
      expect(page.records.map((record) => record.target_system)).toEqual([
        UNIFIED_DATA_STORE,
        UNIFIED_DATA_STORE,
        UNIFIED_DATA_STORE,
        UNIFIED_DATA_STORE,
      ]);
      expect(page.records.map((record) => record.source)).toEqual(["sap", "sap", "generic", "sap"]);
      expect(page.records.every((record) => !("class_rank" in record))).toBe(true);
      expect(page.lineage).toHaveLength(4);
      expect(page.lineage.every((pipeline) => pipeline.count === 25_000)).toBe(true);
      expect(page.lineage.every((pipeline) => pipeline.targetSystem === UNIFIED_DATA_STORE)).toBe(true);
      expect(page.facets.products.map((item) => item.key).sort())
        .toEqual([...ALL_WAREHOUSE_PRODUCTS].sort());
    } finally {
      warehouse.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("normalizes a legacy store label in API results without rewriting persisted facts", () => {
    const directory = mkdtempSync(join(tmpdir(), "cca-legacy-warehouse-test-"));
    const path = join(directory, "warehouse.sqlite");
    const seeded = openWarehouse({ path, rows: 4 });
    seeded.close();

    const legacy = new DatabaseSync(path);
    try {
      legacy.prepare("UPDATE facts SET target_system = ?").run("CCA Unified Data Store");
    } finally {
      legacy.close();
    }

    const locker = new DatabaseSync(path);
    locker.exec("BEGIN IMMEDIATE");
    let warehouse: ReturnType<typeof openWarehouse> | undefined;
    try {
      warehouse = openWarehouse({ path, rows: 4 });
      const page = warehouse.page(
        { sql: "1=1", params: [] },
        WAREHOUSE_ALLOWED_FIELDS,
        [],
        0,
        4,
      );
      const dashboard = warehouse.query(
        { sql: "1=1", params: [] },
        WAREHOUSE_ALLOWED_FIELDS,
        [],
        4,
      );

      expect(page.records.map((record) => record.target_system)).toEqual([
        UNIFIED_DATA_STORE,
        UNIFIED_DATA_STORE,
        UNIFIED_DATA_STORE,
        UNIFIED_DATA_STORE,
      ]);
      expect(page.lineage.every((pipeline) => pipeline.targetSystem === UNIFIED_DATA_STORE)).toBe(true);
      expect(dashboard.sample.every((record) => record.target_system === UNIFIED_DATA_STORE)).toBe(true);
    } finally {
      warehouse?.close();
      locker.exec("ROLLBACK");
      locker.close();
    }

    const persisted = new DatabaseSync(path, { readOnly: true });
    try {
      const counts = persisted.prepare(`
        SELECT
          SUM(CASE WHEN target_system = 'CCA Unified Data Store' THEN 1 ELSE 0 END) AS legacy,
          SUM(CASE WHEN target_system = ? THEN 1 ELSE 0 END) AS current
        FROM facts
      `).get(UNIFIED_DATA_STORE) as { legacy: number; current: number };
      expect(Number(counts.legacy)).toBe(4);
      expect(Number(counts.current)).toBe(0);
    } finally {
      persisted.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
