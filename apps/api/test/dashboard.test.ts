import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { seedStore, WAREHOUSE_ALLOWED_FIELDS } from "@cca/core";
import { buildApp } from "../src/app.js";

async function login(app: FastifyInstance, username: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password: "cca-demo" },
  });
  return (response.json() as { token: string }).token;
}

describe("warehouse dashboard", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp(seedStore());
  });

  afterEach(async () => {
    await app.close();
  });

  it("isolates ACME and Globex on the million-row style warehouse", async () => {
    const emma = await login(app, "emma.acme");
    const finn = await login(app, "finn.globex");
    const acme = await app.inject({
      method: "GET",
      url: "/api/dashboard?purpose=analytics",
      headers: { authorization: `Bearer ${emma}` },
    });
    const globex = await app.inject({
      method: "GET",
      url: "/api/dashboard?purpose=analytics",
      headers: { authorization: `Bearer ${finn}` },
    });
    const acmeBody = acme.json();
    const globexBody = globex.json();
    expect(acmeBody).not.toHaveProperty("total");
    expect(globexBody).not.toHaveProperty("total");
    expect(acmeBody.visible).toBeGreaterThan(0);
    expect(globexBody.visible).toBeGreaterThan(0);
    expect(acmeBody.sample.every((row: { tenant: string }) => row.tenant === "ACME")).toBe(true);
    expect(globexBody.sample.every((row: { tenant: string }) => row.tenant === "GLOBEX")).toBe(true);
    expect(acmeBody.sample.some((row: { account_number?: string }) => row.account_number)).toBe(false);
  });

  it("lets L1 see only internal events and tickets", async () => {
    const token = await login(app, "ana.l1");
    const dash = await app.inject({
      method: "GET",
      url: "/api/dashboard?purpose=support",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = dash.json();
    expect(body.sample.every((row: { product: string; sensitivity: string }) =>
      ["events", "tickets", "process_chains"].includes(row.product) && row.sensitivity === "internal",
    )).toBe(true);
    expect(body.sample.some((row: { email?: string }) => row.email)).toBe(false);
  });

  it("pages the unified warehouse for the explicit Data Owner with a decision receipt", async () => {
    const token = await login(app, "dana.owner");
    const first = await app.inject({
      method: "GET",
      url: "/api/warehouse/records?purpose=data-governance&limit=17",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body).toMatchObject({
      purpose: "data-governance",
      visible: 2500,
      total: 2500,
      receipt: {
        subjectId: "dana.owner",
        personaId: "data-owner",
        effect: "allow",
        reason: "contract_allow",
        contractIds: ["wh.data-owner"],
        capsuleIds: ["data-governance-owner"],
        denyFields: [],
      },
    });
    expect(body.records).toHaveLength(17);
    expect(body.nextCursor).toBe(17);
    expect(body.lineage).toHaveLength(4);
    expect(body.lineage.reduce((sum: number, item: { count: number }) => sum + item.count, 0)).toBe(2500);
    expect(body.lineage.map((item: { pipelineId: string }) => item.pipelineId).sort()).toEqual([
      "azure-adf-business-load",
      "sap-bobj-report-refresh",
      "sap-bw-elastic-ops",
      "sap-s4-bw-vendor",
    ]);
    expect([...body.dataset.allowedFields].sort()).toEqual([...WAREHOUSE_ALLOWED_FIELDS].sort());
    expect([...body.receipt.allowedFields].sort()).toEqual([...WAREHOUSE_ALLOWED_FIELDS].sort());
    expect(body.dataset.allowedFields).toEqual(expect.arrayContaining(["bank_account", "payload"]));
    expect(body.records.every((row: Record<string, unknown>) =>
      "pipeline_id" in row
      && "pipeline_name" in row
      && "source_system" in row
      && "target_system" in row
      && !("class_rank" in row)
    )).toBe(true);

    const second = await app.inject({
      method: "GET",
      url: `/api/warehouse/records?purpose=data-governance&limit=17&cursor=${body.nextCursor}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.statusCode).toBe(200);
    const firstIds = new Set(body.records.map((row: { id: number }) => row.id));
    expect(second.json().records.every((row: { id: number }) => !firstIds.has(row.id))).toBe(true);
  });

  it("enforces the current user's row and field scope on paged warehouse records", async () => {
    const emma = await login(app, "emma.acme");
    const l1 = await login(app, "ana.l1");
    const l2bw = await login(app, "ben.l2bw");
    const admin = await login(app, "hugo.admin");

    const acme = await app.inject({
      method: "GET",
      url: "/api/warehouse/records?purpose=analytics&limit=100",
      headers: { authorization: `Bearer ${emma}` },
    });
    expect(acme.statusCode).toBe(200);
    const acmeBody = acme.json();
    expect(acmeBody).not.toHaveProperty("total");
    expect(acmeBody.visible).toBeGreaterThan(0);
    expect(acmeBody.receipt).toMatchObject({
      subjectId: "emma.acme",
      effect: "allow",
      contractIds: ["wh.acme"],
      denyFields: [],
      protectedFieldCount: 5,
    });
    expect(acmeBody.dataset.allowedFields).not.toEqual(expect.arrayContaining(["bank_account", "payload"]));
    expect(JSON.stringify(acmeBody)).not.toContain('"bank_account"');
    expect(JSON.stringify(acmeBody)).not.toContain('"payload"');
    expect(acmeBody.records.every((row: Record<string, unknown>) =>
      row.tenant === "ACME"
      && ["customers", "transactions", "inventory", "bw_vendor"].includes(String(row.product))
      && !["email", "account_number", "payload", "bank_account", "legal_name"]
        .some((field) => field in row)
    )).toBe(true);
    expect(acmeBody.lineage.reduce((sum: number, item: { count: number }) => sum + item.count, 0))
      .toBe(acmeBody.visible);

    const support = await app.inject({
      method: "GET",
      url: "/api/warehouse/records?purpose=support&limit=100",
      headers: { authorization: `Bearer ${l1}` },
    });
    const supportBody = support.json();
    expect(supportBody).not.toHaveProperty("total");
    expect(supportBody.records.every((row: Record<string, unknown>) =>
      ["events", "tickets", "process_chains"].includes(String(row.product))
      && row.sensitivity === "internal"
      && !["email", "account_number", "payload", "vendor_id", "bank_account", "legal_name"]
        .some((field) => field in row)
    )).toBe(true);

    const bwOperations = await app.inject({
      method: "GET",
      url: "/api/warehouse/records?purpose=operations&limit=100",
      headers: { authorization: `Bearer ${l2bw}` },
    });
    expect(bwOperations.statusCode).toBe(200);
    const bwOperationsBody = bwOperations.json();
    expect(bwOperationsBody.records.every((row: Record<string, unknown>) =>
      ["events", "transactions", "telemetry", "process_chains", "bw_vendor"].includes(String(row.product))
      && row.sensitivity !== "restricted"
      && !["email", "account_number", "payload", "bank_account", "legal_name"]
        .some((field) => field in row)
    )).toBe(true);
    expect(JSON.stringify(bwOperationsBody)).not.toContain('"payload"');

    const governance = await app.inject({
      method: "GET",
      url: "/api/warehouse/records?purpose=governance",
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(governance.statusCode).toBe(200);
    const governanceBody = governance.json();
    expect(governanceBody).toMatchObject({
      visible: 0,
      records: [],
      lineage: [],
      receipt: { subjectId: "hugo.admin", effect: "deny", reason: "no_contract_binding" },
    });
    expect(governanceBody).not.toHaveProperty("total");
    expect(governanceBody.dataset).not.toHaveProperty("allowedFields");
    expect(JSON.stringify(governanceBody)).not.toContain('"bank_account"');
    expect(JSON.stringify(governanceBody)).not.toContain('"payload"');
  });

  it("does not accept a caller-selected principal on warehouse record queries", async () => {
    const token = await login(app, "emma.acme");
    const injected = await app.inject({
      method: "GET",
      url: "/api/warehouse/records?purpose=analytics&principalId=dana.owner",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(injected.statusCode).toBe(400);
    expect(injected.json().code).toBe("validation_error");

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/warehouse/records?purpose=analytics",
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("reports the effective membership persona when it differs from the token persona", async () => {
    await app.close();
    const store = seedStore();
    store.personas.set("custom.finance-analyst", {
      id: "custom.finance-analyst",
      label: "Regional finance analyst",
      actions: ["view"],
      ceiling: "confidential",
      inherits: "consumer",
    });
    store.capsules.set("custom-finance-acme", {
      id: "custom-finance-acme",
      label: "ACME finance slice",
      purpose: "finance",
      active: true,
      attrs: { products: ["transactions"], tenants: ["ACME"], sources: ["generic"] },
    });
    store.memberships.push({
      principalId: "emma.acme",
      capsuleId: "custom-finance-acme",
      personaId: "custom.finance-analyst",
    });
    store.contracts.set("wh.custom-finance", {
      id: "wh.custom-finance",
      datasetId: "warehouse",
      purpose: "finance",
      allowedPersonas: ["custom.finance-analyst"],
      actions: ["view"],
      classificationMax: "confidential",
      predicate: {
        op: "and",
        clauses: [
          { op: "fromCapsuleAttr", field: "product", attr: "products" },
          { op: "fromCapsuleAttr", field: "tenant", attr: "tenants" },
          { op: "fromCapsuleAttr", field: "source", attr: "sources" },
        ],
      },
      allowFields: ["id", "product", "tenant", "amount", "sensitivity"],
      denyFields: [],
    });
    store.bindings.push({
      id: "bind-custom-finance",
      capsuleId: "custom-finance-acme",
      contractId: "wh.custom-finance",
    });
    app = buildApp(store);

    const token = await login(app, "emma.acme");
    const response = await app.inject({
      method: "GET",
      url: "/api/warehouse/records?purpose=finance&limit=100",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.receipt).toMatchObject({
      subjectId: "emma.acme",
      personaId: "consumer",
      tokenPersonaId: "consumer",
      effectiveAssignments: [{
        capsuleId: "custom-finance-acme",
        capsuleLabel: "ACME finance slice",
        personaId: "custom.finance-analyst",
        personaLabel: "Regional finance analyst",
      }],
      contractIds: ["wh.custom-finance"],
      capsuleIds: ["custom-finance-acme"],
    });
    expect(body.visible).toBeGreaterThan(0);
    expect(body.records.every((row: Record<string, unknown>) =>
      row.product === "transactions" && row.tenant === "ACME"
    )).toBe(true);
  });

  it("projects samples and aggregates through the warehouse field allowlist", async () => {
    await app.close();
    const store = seedStore();
    store.datasets.get("warehouse")!.allowedFields = ["id", "product", "tenant"];
    app = buildApp(store);
    const token = await login(app, "emma.acme");
    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard?purpose=analytics",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.visible).toBeGreaterThan(0);
    expect(body.sample.length).toBeGreaterThan(0);
    expect(body.sample.every((row: Record<string, unknown>) =>
      Object.keys(row).every((field) => ["id", "product", "tenant"].includes(field)),
    )).toBe(true);
    expect(body.byProduct.every((item: { amount?: number }) => item.amount === undefined)).toBe(true);
    expect(body.byRegion).toEqual([]);
    expect(body.byDepartment).toEqual([]);
    expect(body.bySensitivity).toEqual([]);
    expect(body.byDay).toEqual([]);
  });

  it("fails closed when the warehouse field allowlist is empty", async () => {
    await app.close();
    const store = seedStore();
    store.datasets.get("warehouse")!.allowedFields = [];
    app = buildApp(store);
    const token = await login(app, "emma.acme");
    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard?purpose=analytics",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ denied: true, visible: 0, sample: [] });
    expect(response.json()).not.toHaveProperty("total");
  });

  it("previews a drafted role without applying it", async () => {
    const token = await login(app, "hugo.admin");
    const preview = await app.inject({
      method: "POST",
      url: "/api/roles/preview",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        draft: {
          name: "EU telemetry",
          verbs: ["view"],
          purpose: "operations",
          ceiling: "internal",
          products: ["telemetry"],
          tenants: [],
          regions: ["EU"],
          departments: [],
          denyFields: ["payload"],
          sources: ["sap"],
        },
      },
    });
    expect(preview.statusCode).toBe(200);
    const body = preview.json();
    expect(body.visible).toBeGreaterThan(0);
    expect(body.total).toBe(2500);
    expect(body.sample).toEqual([]);
    expect(body.byDay).toEqual([]);
    expect(body.byProduct.every((item: { amount?: number }) => item.amount === undefined)).toBe(true);
    expect(body.previewMode).toBe("metadata");
  });

  it("applies a custom role and changes what the user can see", async () => {
    const token = await login(app, "emma.acme");
    const admin = await login(app, "hugo.admin");
    const owner = await login(app, "dana.owner");
    const draft = {
      name: "ACME NA finance",
      verbs: ["view"],
      purpose: "finance",
      ceiling: "confidential",
      products: ["transactions"],
      tenants: ["ACME"],
      regions: ["NA"],
      departments: ["finance"],
      denyFields: ["account_number", "email"],
      sources: ["generic"],
    };
    const before = await app.inject({
      method: "GET",
      url: "/api/dashboard?purpose=analytics",
      headers: { authorization: `Bearer ${token}` },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/role-requests",
      headers: { authorization: `Bearer ${token}` },
      payload: { draft },
    });
    expect(created.statusCode).toBe(200);
    const adminApproval = await app.inject({
      method: "POST",
      url: `/api/role-requests/${created.json().id}/approve`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(adminApproval.json().status).toBe("pending");
    const applied = await app.inject({
      method: "POST",
      url: `/api/role-requests/${created.json().id}/approve`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(applied.statusCode).toBe(200);
    const body = applied.json();
    expect(body.applied.personaId).toMatch(/^capability\./);
    expect(body.status).toBe("approved");
    const refreshed = await login(app, "emma.acme");
    const after = await app.inject({
      method: "GET",
      url: "/api/dashboard?purpose=finance",
      headers: { authorization: `Bearer ${refreshed}` },
    });
    expect(after.json().visible).toBeLessThan(before.json().visible);
    expect(after.json().sample.every((row: { product: string; region: string; department: string }) =>
      row.product === "transactions" && row.region === "NA" && row.department === "finance",
    )).toBe(true);
  });

  it("generates a role from a SAP ask and a generic ask", async () => {
    const token = await login(app, "hugo.admin");
    const sap = await app.inject({
      method: "POST",
      url: "/api/roles/from-ask",
      headers: { authorization: `Bearer ${token}` },
      payload: { ask: "L1 support should see process chain health but not vendor PII" },
    });
    expect(sap.statusCode).toBe(200);
    const sapBody = sap.json();
    expect(sapBody.draft.products).toEqual(["process_chains"]);
    expect(sapBody.draft.sources).toEqual(["sap"]);
    expect(sapBody.preview.sample.every((row: { product: string; vendor_id?: string }) =>
      row.product === "process_chains" && !row.vendor_id,
    )).toBe(true);

    const generic = await app.inject({
      method: "POST",
      url: "/api/roles/from-ask",
      headers: { authorization: `Bearer ${token}` },
      payload: { ask: "ACME finance team only NA transactions" },
    });
    const genericBody = generic.json();
    expect(genericBody.draft.tenants).toEqual(["ACME"]);
    expect(genericBody.draft.products).toEqual(["transactions"]);
    expect(genericBody.preview.sample.every((row: { tenant: string; region: string }) =>
      row.tenant === "ACME" && row.region === "NA",
    )).toBe(true);
  });
});
