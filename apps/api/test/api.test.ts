import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { seedStore } from "@cca/core";
import { buildApp } from "../src/app.js";

async function login(app: FastifyInstance, username: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password: "cca-demo" },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { token: string };
  return body.token;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("CCA HTTP API", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp(seedStore());
  });

  afterEach(async () => {
    await app.close();
  });

  it("publishes the demo directory without a token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/auth/directory" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ username: "emma.acme" }),
        expect.objectContaining({ username: "dana.owner", persona: "Data Owner" }),
        expect.objectContaining({ username: "hugo.admin" }),
      ]),
    );
    expect(body).not.toHaveProperty("baseline");
    expect(response.body).not.toContain("passwordHash");
  });

  it("does not publish the demo directory in production mode", async () => {
    const production = buildApp(seedStore(), { demoMode: false });
    try {
      const response = await production.inject({ method: "GET", url: "/api/auth/directory" });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "not found", code: "not_found" });
      expect(response.body).not.toContain("baseline");
    } finally {
      await production.close();
    }
  });

  it("rejects bad credentials and missing tokens", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "emma.acme", password: "nope" },
    });
    expect(bad.statusCode).toBe(401);
    const me = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(me.statusCode).toBe(401);
  });

  it("issues an audience-bound token and returns the principal", async () => {
    const token = await login(app, "emma.acme");
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      id: "emma.acme",
      personaId: "consumer",
    });
  });

  it("isolates ACME and Globex on the shared BW dataset", async () => {
    const emma = await login(app, "emma.acme");
    const finn = await login(app, "finn.globex");
    const acme = await app.inject({
      method: "GET",
      url: "/api/data/bw_vendor?purpose=vendor-performance",
      headers: auth(emma),
    });
    const globex = await app.inject({
      method: "GET",
      url: "/api/data/bw_vendor?purpose=vendor-performance",
      headers: auth(finn),
    });
    const acmeIds = (acme.json().records as { attrs: { vendor_id: string } }[]).map(
      (r) => r.attrs.vendor_id,
    );
    const globexIds = (globex.json().records as { attrs: { vendor_id: string } }[]).map(
      (r) => r.attrs.vendor_id,
    );
    expect(acmeIds.sort()).toEqual(["V1001", "V1002"]);
    expect(globexIds.sort()).toEqual(["V2001", "V2002"]);
  });

  it("returns the expected BW vendor slice for every seeded human role", async () => {
    const expectations = [
      ["ana.l1", "incident-triage", []],
      ["ben.l2bw", "replication-repair", []],
      ["cara.l2bobj", "report-repair", []],
      ["dev.obs", "pipeline-reliability", []],
      ["emma.acme", "vendor-performance", ["V1001", "V1002"]],
      ["finn.globex", "vendor-performance", ["V2001", "V2002"]],
      ["gita.steward", "vendor-performance", ["V1001", "V1002"]],
      ["dana.owner", "data-governance", []],
      ["hugo.admin", "governance", []],
      ["iris.admin", "governance", []],
    ] as const;

    for (const [username, purpose, expectedVendorIds] of expectations) {
      const token = await login(app, username);
      const response = await app.inject({
        method: "GET",
        url: `/api/data/bw_vendor?purpose=${purpose}`,
        headers: auth(token),
      });
      expect(response.statusCode).toBe(200);
      const vendorIds = (response.json().records as Array<{ attrs: { vendor_id?: string } }>)
        .map((record) => record.attrs.vendor_id)
        .filter((value): value is string => Boolean(value))
        .sort();
      expect(vendorIds, username).toEqual([...expectedVendorIds].sort());
    }
  });

  it("hides S/4 vendor master from L1 and from admin standing access", async () => {
    const l1 = await login(app, "ana.l1");
    const admin = await login(app, "hugo.admin");
    const l1Data = await app.inject({
      method: "GET",
      url: "/api/data/s4_vendor?purpose=incident-triage",
      headers: auth(l1),
    });
    const adminData = await app.inject({
      method: "GET",
      url: "/api/data/s4_vendor?purpose=governance",
      headers: auth(admin),
    });
    expect(l1Data.json().records).toEqual([]);
    expect(adminData.json().records).toEqual([]);
  });

  it("forbids non-admins from offboarding and compiler dumps", async () => {
    const emma = await login(app, "emma.acme");
    const off = await app.inject({
      method: "POST",
      url: "/api/capsules/vendor-acme/offboard",
      headers: auth(emma),
      payload: {},
    });
    const compiled = await app.inject({
      method: "GET",
      url: "/api/compiler/vendor-acme",
      headers: auth(emma),
    });
    expect(off.statusCode).toBe(403);
    expect(compiled.statusCode).toBe(403);
  });

  it("offboards ACME in one call and leaves Globex intact", async () => {
    const admin = await login(app, "hugo.admin");
    const emma = await login(app, "emma.acme");
    const finn = await login(app, "finn.globex");
    const off = await app.inject({
      method: "POST",
      url: "/api/capsules/vendor-acme/offboard",
      headers: auth(admin),
      payload: {},
    });
    expect(off.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET",
      url: "/api/data/bw_vendor?purpose=vendor-performance",
      headers: auth(emma),
    });
    const globex = await app.inject({
      method: "GET",
      url: "/api/data/bw_vendor?purpose=vendor-performance",
      headers: auth(finn),
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().code).toBe("session_stale");
    const refreshedEmma = await login(app, "emma.acme");
    const denied = await app.inject({
      method: "GET",
      url: "/api/data/bw_vendor?purpose=vendor-performance",
      headers: auth(refreshedEmma),
    });
    expect(denied.json().records).toEqual([]);
    expect(globex.json().records).toHaveLength(2);
  });

  it("JIT requires dual control and exposes only the approved BW vendor slice", async () => {
    const l2 = await login(app, "ben.l2bw");
    const admin = await login(app, "hugo.admin");
    const created = await app.inject({
      method: "POST",
      url: "/api/jit",
      headers: auth(l2),
      payload: {
        datasetId: "bw_vendor",
        capsuleId: "support-l2-bw",
        purpose: "replication-repair",
        actions: ["view"],
        justification: "Investigate a failed replication package",
        durationMs: 60_000,
      },
    });
    expect(created.statusCode).toBe(200);
    const self = await app.inject({
      method: "POST",
      url: `/api/jit/${created.json().id}/approve`,
      headers: auth(l2),
      payload: { ttlMs: 60_000 },
    });
    expect(self.statusCode).toBe(403);
    const approved = await app.inject({
      method: "POST",
      url: `/api/jit/${created.json().id}/approve`,
      headers: auth(admin),
      payload: { ttlMs: 60_000 },
    });
    expect(approved.statusCode).toBe(200);
    const data = await app.inject({
      method: "GET",
      url: "/api/data/bw_vendor?purpose=replication-repair",
      headers: auth(l2),
    });
    expect(data.json().records.map((row: { attrs: { vendor_id: string } }) => row.attrs.vendor_id))
      .toEqual(["V1001", "V1002"]);
    expect(data.json().records.every((row: { attrs: Record<string, unknown> }) => !("spend" in row.attrs)))
      .toBe(true);
    const revoked = await app.inject({
      method: "POST",
      url: `/api/jit/${created.json().id}/revoke`,
      headers: auth(l2),
      payload: { reason: "Replication incident resolved" },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({
      status: "revoked",
      revokedBy: "ben.l2bw",
      revocationReason: "Replication incident resolved",
    });
    const denied = await app.inject({
      method: "GET",
      url: "/api/data/bw_vendor?purpose=replication-repair",
      headers: auth(l2),
    });
    expect(denied.json().records).toEqual([]);
    const audit = await app.inject({ method: "GET", url: "/api/audit", headers: auth(admin) });
    expect(audit.json().events).toContainEqual(expect.objectContaining({ type: "jit.revoke" }));
  });

  it("supports an explicit, evidenced JIT denial decision", async () => {
    const l2 = await login(app, "ben.l2bw");
    const admin = await login(app, "hugo.admin");
    const created = await app.inject({
      method: "POST",
      url: "/api/jit",
      headers: auth(l2),
      payload: {
        datasetId: "bw_vendor",
        capsuleId: "support-l2-bw",
        purpose: "replication-repair",
        actions: ["view"],
        justification: "Investigate a failed replication package",
        durationMs: 60_000,
      },
    });
    const denied = await app.inject({
      method: "POST",
      url: `/api/jit/${created.json().id}/deny`,
      headers: auth(admin),
      payload: { reason: "Change ticket does not authorize production access" },
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toMatchObject({
      status: "denied",
      deniedBy: "hugo.admin",
      denialReason: "Change ticket does not authorize production access",
    });
    const laterApproval = await app.inject({
      method: "POST",
      url: `/api/jit/${created.json().id}/approve`,
      headers: auth(admin),
      payload: { ttlMs: 60_000 },
    });
    expect(laterApproval.statusCode).toBe(400);
    const audit = await app.inject({ method: "GET", url: "/api/audit", headers: auth(admin) });
    expect(audit.json().events).toContainEqual(expect.objectContaining({ type: "jit.deny" }));
  });

  it("strips ES payload fields for observability", async () => {
    const obs = await login(app, "dev.obs");
    const data = await app.inject({
      method: "GET",
      url: "/api/data/es_tech?purpose=pipeline-reliability",
      headers: auth(obs),
    });
    const rows = data.json().records as { attrs: Record<string, unknown> }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => "payload" in r.attrs)).toBe(false);
  });

  it("exposes a strict AuthZEN evaluation adapter with row-scoped obligations", async () => {
    const emma = await login(app, "emma.acme");
    const evaluate = (recordId: string) => app.inject({
      method: "POST",
      url: "/access/v1/evaluation",
      headers: auth(emma),
      payload: {
        subject: { type: "user", id: "emma.acme" },
        action: { name: "view" },
        resource: { type: "dataset", id: "bw_vendor" },
        context: { purpose: "vendor-performance", recordId },
      },
    });

    const acme = await evaluate("bw-1");
    expect(acme.statusCode).toBe(200);
    expect(acme.json()).toMatchObject({
      decision: true,
      context: {
        reason: "contract_allow",
        obligations: {
          allowedFields: ["region", "spend", "vendor_id", "vendor_name"],
          denyFields: [],
          contractIds: ["vendor.acme.slice"],
          capsuleIds: ["vendor-acme"],
        },
      },
    });
    expect((await evaluate("bw-3")).json()).toMatchObject({
      decision: false,
      context: { reason: "predicate_miss" },
    });
    expect((await evaluate("missing-record")).json()).toMatchObject({
      decision: false,
      context: { reason: "record_unknown" },
    });

    const crossSubject = await app.inject({
      method: "POST",
      url: "/access/v1/evaluation",
      headers: auth(emma),
      payload: {
        subject: { id: "finn.globex" },
        action: { name: "view" },
        resource: { id: "bw_vendor" },
        context: { purpose: "vendor-performance", recordId: "bw-3" },
      },
    });
    expect(crossSubject.statusCode).toBe(403);

    const malformed = await app.inject({
      method: "POST",
      url: "/access/v1/evaluation",
      headers: auth(emma),
      payload: {
        subject: { id: "emma.acme", injected: true },
        action: { name: "view" },
        resource: { id: "bw_vendor" },
        context: { purpose: "vendor-performance", recordId: "bw-1" },
      },
    });
    expect(malformed.statusCode).toBe(400);
  });
});
