import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  applyRoleDraft,
  requestJit,
  seedStore,
  verifyPassword,
  WAREHOUSE_ALLOWED_FIELDS,
  type RoleDraft,
} from "@cca/core";
import {
  createApiControlState,
  loadOrInitializeControlPlane,
  SqliteControlPlaneRepository,
} from "../src/control-plane.js";
import { assertJwtConfiguration, verifyAccessToken } from "../src/jwt.js";
import { openWarehouse } from "../src/warehouse.js";

const tokenEnvironment: NodeJS.ProcessEnv = {
  CCA_MODE: "test",
  CCA_JWT_SECRET: "test-secret-that-is-long-enough-for-production",
};
const VALID_AUTHORIZATION_FINGERPRINT = "a".repeat(64);

describe("production safety boundaries", () => {
  it("rejects the bundled demonstration secret in production", () => {
    expect(() => assertJwtConfiguration({
      CCA_MODE: "production",
      CCA_JWT_SECRET: "cca-demo-only-secret-not-for-production",
    })).toThrow(/demonstration secret/);
  });

  it.each(["exp", "iat", "jti"] as const)("rejects access tokens missing %s", async (missingClaim) => {
    let builder = new SignJWT({
      persona: "consumer",
      capsules: ["finance-acme"],
      authorizationFingerprint: VALID_AUTHORIZATION_FINGERPRINT,
      kind: "human",
      authenticationAssurance: "password",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("cca-api")
      .setIssuer("cca-control-plane")
      .setSubject("emma.acme");
    if (missingClaim !== "iat") builder = builder.setIssuedAt();
    if (missingClaim !== "exp") builder = builder.setExpirationTime("15m");
    if (missingClaim !== "jti") builder = builder.setJti("test-token-id");
    const token = await builder.sign(new TextEncoder().encode(tokenEnvironment.CCA_JWT_SECRET));

    await expect(verifyAccessToken(token, tokenEnvironment)).rejects.toThrow();
  });

  it("bounds token lifetime and future issued-at skew", async () => {
    const now = Math.floor(Date.now() / 1000);
    const unsafeTimes = [
      { iat: now + 30, exp: now + 30 },
      { iat: now, exp: now + 60 * 60 + 1 },
      { iat: now + 300, exp: now + 360 },
    ];
    for (const times of unsafeTimes) {
      const token = await new SignJWT({
        persona: "consumer",
        capsules: ["finance-acme"],
        authorizationFingerprint: VALID_AUTHORIZATION_FINGERPRINT,
        kind: "human",
        authenticationAssurance: "password",
      })
        .setProtectedHeader({ alg: "HS256" })
        .setAudience("cca-api")
        .setIssuer("cca-control-plane")
        .setSubject("emma.acme")
        .setJti("bounded-token-id")
        .setIssuedAt(times.iat)
        .setExpirationTime(times.exp)
        .sign(new TextEncoder().encode(tokenEnvironment.CCA_JWT_SECRET));
      await expect(verifyAccessToken(token, tokenEnvironment)).rejects.toThrow(/invalid access-token claims/);
    }
  });

  it.each([undefined, "", "a".repeat(63), "A".repeat(64)])(
    "rejects a missing or malformed authorization fingerprint (%j)",
    async (authorizationFingerprint) => {
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({
        persona: "consumer",
        capsules: ["finance-acme"],
        authorizationFingerprint,
        kind: "human",
        authenticationAssurance: "password",
      })
        .setProtectedHeader({ alg: "HS256" })
        .setAudience("cca-api")
        .setIssuer("cca-control-plane")
        .setSubject("emma.acme")
        .setJti("malformed-authorization-fingerprint-token-id")
        .setIssuedAt(now)
        .setExpirationTime(now + 900)
        .sign(new TextEncoder().encode(tokenEnvironment.CCA_JWT_SECRET));

      await expect(verifyAccessToken(token, tokenEnvironment)).rejects.toThrow(/invalid access-token claims/);
    },
  );

  it.each([42, "   "])("rejects a malformed optional token purpose (%j)", async (purpose) => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      persona: "consumer",
      capsules: ["finance-acme"],
      authorizationFingerprint: VALID_AUTHORIZATION_FINGERPRINT,
      kind: "human",
      authenticationAssurance: "password",
      purpose,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("cca-api")
      .setIssuer("cca-control-plane")
      .setSubject("emma.acme")
      .setJti("malformed-purpose-token-id")
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(new TextEncoder().encode(tokenEnvironment.CCA_JWT_SECRET));

    await expect(verifyAccessToken(token, tokenEnvironment)).rejects.toThrow(/invalid access-token claims/);
  });

  it("requires a purpose claim on production tokens", async () => {
    const environment: NodeJS.ProcessEnv = {
      CCA_MODE: "production",
      CCA_JWT_SECRET: "production-test-secret-with-at-least-32-characters",
    };
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      persona: "consumer",
      capsules: ["vendor-acme"],
      authorizationFingerprint: VALID_AUTHORIZATION_FINGERPRINT,
      kind: "human",
      authenticationAssurance: "password",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("cca-api")
      .setIssuer("cca-control-plane")
      .setSubject("emma.acme")
      .setJti("production-purpose-token-id")
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(new TextEncoder().encode(environment.CCA_JWT_SECRET));

    await expect(verifyAccessToken(token, environment)).rejects.toThrow(/invalid access-token claims/);
  });

  it("does not create or seed a missing production control-plane database", () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "cca-production-control-test-"));
    const path = join(directory, "control.sqlite");
    try {
      expect(() => new SqliteControlPlaneRepository(path, { requireExisting: true })).toThrow(/does not exist/);
      expect(existsSync(path)).toBe(false);

      const empty = new SqliteControlPlaneRepository(path);
      expect(() => loadOrInitializeControlPlane(empty, "production")).toThrow(/validated control-plane snapshot/);
      expect(empty.load()).toBeUndefined();
      empty.close();

      expect(() => new SqliteControlPlaneRepository(path, { requireExisting: true })).toThrow(/snapshot/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts a validated existing control-plane snapshot in production", () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "cca-existing-control-test-"));
    const path = join(directory, "control.sqlite");
    try {
      const provisioner = new SqliteControlPlaneRepository(path);
      const provisioned = loadOrInitializeControlPlane(provisioner, "test");
      const expectedPrincipalCount = provisioned.store.principals.size;
      provisioner.close();

      const production = new SqliteControlPlaneRepository(path, { requireExisting: true });
      const loaded = loadOrInitializeControlPlane(production, "production");
      expect(loaded.store.principals.size).toBe(expectedPrincipalCount);
      production.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reconciles an older v3 demo seed without replacing user-created or workflow state", () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "cca-demo-reconcile-test-"));
    const path = join(directory, "control.sqlite");
    try {
      const provisioner = new SqliteControlPlaneRepository(path);
      provisioner.close();
      const legacy = legacyDemoControlPlane();
      const customContractId = legacy.customContractId;
      const customContract = structuredClone(legacy.store.contracts.get(customContractId));
      const auditBefore = legacy.store.audit;
      const jitBefore = structuredClone(legacy.store.jit);
      const stateBefore = structuredClone(legacy.state);
      writeControlEnvelope(path, { version: 1, store: legacy.store.snapshot(), api: legacy.state });

      const repository = new SqliteControlPlaneRepository(path);
      const save = vi.spyOn(repository, "save");
      const loaded = loadOrInitializeControlPlane(repository, "demo");
      expect(save).toHaveBeenCalledTimes(1);
      expect(loaded.store.personas.has("data-owner")).toBe(true);
      expect(loaded.store.capsules.has("data-governance-owner")).toBe(true);
      expect(loaded.store.principals.get("dana.owner")).toMatchObject({ disabled: false, personaId: "data-owner" });
      expect(verifyPassword("cca-demo", loaded.store.principals.get("dana.owner")!.passwordHash)).toBe(true);
      expect(loaded.store.principals.get("iris.admin")).toMatchObject({ disabled: false, personaId: "admin" });
      expect(loaded.store.memberships).toContainEqual(expect.objectContaining({
        principalId: "dana.owner",
        capsuleId: "data-governance-owner",
        personaId: "data-owner",
        assignmentId: expect.any(String),
      }));
      expect(loaded.store.memberships).toContainEqual(expect.objectContaining({
        principalId: "iris.admin",
        capsuleId: "control-plane",
        personaId: "admin",
        assignmentId: expect.any(String),
      }));
      expect(loaded.store.bindings.some((binding) =>
        binding.capsuleId === "data-governance-owner" && binding.contractId === "wh.data-owner"
      )).toBe(true);
      expect(loaded.store.datasets.get("warehouse")).toMatchObject({
        classification: "restricted",
        allowedFields: [...WAREHOUSE_ALLOWED_FIELDS],
      });
      for (const id of ["wh.l1", "wh.l2bw", "wh.l2bobj", "wh.obs", "wh.acme", "wh.globex", "wh.data-owner"]) {
        expect(loaded.store.contracts.get(id)?.allowFields?.length).toBeGreaterThan(0);
      }
      expect(loaded.store.contracts.get(customContractId)).toEqual(customContract);
      expect(loaded.store.jit).toEqual(jitBefore);
      expect(loaded.state).toEqual(stateBefore);
      expect(loaded.store.audit.slice(0, auditBefore.length)).toEqual(auditBefore);
      expect(loaded.store.audit.at(-1)?.type).toBe("store.reconcile.demo-seed");

      const firstSnapshot = loaded.store.snapshot();
      save.mockClear();
      const loadedAgain = loadOrInitializeControlPlane(repository, "demo");
      expect(save).not.toHaveBeenCalled();
      expect(loadedAgain.store.snapshot()).toEqual(firstSnapshot);
      repository.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never reconciles a persisted v3 snapshot in production", () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "cca-production-no-reconcile-test-"));
    const path = join(directory, "control.sqlite");
    try {
      const provisioner = new SqliteControlPlaneRepository(path);
      provisioner.close();
      const legacy = legacyDemoControlPlane();
      const auditBefore = legacy.store.audit;
      writeControlEnvelope(path, { version: 1, store: legacy.store.snapshot(), api: legacy.state });

      const repository = new SqliteControlPlaneRepository(path, { requireExisting: true });
      const save = vi.spyOn(repository, "save");
      const loaded = loadOrInitializeControlPlane(repository, "production");
      expect(save).not.toHaveBeenCalled();
      expect(loaded.store.principals.has("dana.owner")).toBe(false);
      expect(loaded.store.datasets.get("warehouse")).toMatchObject({
        classification: "confidential",
        allowedFields: ["id", "product"],
      });
      expect(loaded.store.audit).toEqual(auditBefore);
      repository.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates an empty-JIT v2 snapshot only in demo/test and persists v3", () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "cca-v2-migration-test-"));
    const path = join(directory, "control.sqlite");
    try {
      const provisioner = new SqliteControlPlaneRepository(path);
      provisioner.close();
      const legacy = seedStore().snapshot() as unknown as Record<string, unknown>;
      legacy.version = 2;
      legacy.jit = [];
      legacy.memberships = (legacy.memberships as Array<Record<string, unknown>>).map((membership) => {
        const { personaId: _personaId, ...withoutPersona } = membership;
        return withoutPersona;
      });
      writeControlEnvelope(path, { version: 1, store: legacy, api: createApiControlState() });

      expect(() => new SqliteControlPlaneRepository(path, { requireExisting: true }))
        .toThrow(/reviewed offline migration/);

      const repository = new SqliteControlPlaneRepository(path);
      const loaded = repository.load("test");
      expect(loaded?.store.snapshot().version).toBe(3);
      expect(loaded?.store.memberships.every((membership) => typeof membership.personaId === "string"))
        .toBe(true);
      expect(loaded?.store.audit.at(-1)?.type).toBe("store.migrate.v2-v3");
      repository.close();

      const production = new SqliteControlPlaneRepository(path, { requireExisting: true });
      expect(production.load("production")?.store.snapshot().version).toBe(3);
      production.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses automatic v2 migration when any legacy JIT state exists", () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "cca-v2-jit-migration-test-"));
    const path = join(directory, "control.sqlite");
    try {
      const provisioner = new SqliteControlPlaneRepository(path);
      provisioner.close();
      const legacy = seedStore().snapshot() as unknown as Record<string, unknown>;
      legacy.version = 2;
      legacy.jit = [{}];
      writeControlEnvelope(path, { version: 1, store: legacy, api: createApiControlState() });
      const repository = new SqliteControlPlaneRepository(path);
      expect(() => repository.load("demo")).toThrow(/legacy JIT grants require reviewed migration/);
      repository.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("opens an existing production warehouse read-only without reseeding it", () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "cca-production-warehouse-test-"));
    const path = join(directory, "warehouse.sqlite");
    try {
      const generated = openWarehouse({ path, rows: 12 });
      generated.close();
      const before = statSync(path);

      const production = openWarehouse({ path, rows: 100, readOnly: true });
      expect(production.count()).toBe(12);
      production.close();

      const after = statSync(path);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to create a missing production warehouse", () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "cca-missing-warehouse-test-"));
    const path = join(directory, "warehouse.sqlite");
    try {
      expect(() => openWarehouse({ path, rows: 10, readOnly: true })).toThrow(/does not exist/);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restricts newly created SQLite files", () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "cca-sqlite-mode-test-"));
    const controlPath = join(directory, "control.sqlite");
    const warehousePath = join(directory, "warehouse.sqlite");
    try {
      const repository = new SqliteControlPlaneRepository(controlPath);
      loadOrInitializeControlPlane(repository, "test");
      repository.close();
      const warehouse = openWarehouse({ path: warehousePath, rows: 5 });
      warehouse.close();

      if (process.platform !== "win32") {
        expect(statSync(controlPath).mode & 0o777).toBe(0o600);
        expect(statSync(warehousePath).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses a durable readiness write without changing authorization state", () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "cca-readiness-write-test-"));
    const path = join(directory, "control.sqlite");
    try {
      const repository = new SqliteControlPlaneRepository(path);
      const control = loadOrInitializeControlPlane(repository, "test");
      const storeBefore = control.store.snapshot();
      const stateBefore = structuredClone(control.state);

      repository.check();
      const loaded = repository.load();
      expect(loaded!.store.snapshot()).toEqual(storeBefore);
      expect(loaded!.state).toEqual(stateBefore);
      repository.close();

      const persisted = new DatabaseSync(path, { readOnly: true });
      const probe = persisted
        .prepare("SELECT checked_at FROM control_plane_readiness WHERE id = 1")
        .get() as { checked_at: number } | undefined;
      expect(Number.isSafeInteger(probe?.checked_at)).toBe(true);
      persisted.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function writeControlEnvelope(path: string, envelope: unknown): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare(`
      INSERT INTO control_plane_state(id, payload, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(JSON.stringify(envelope), Date.now());
  } finally {
    db.close();
  }
}

function legacyDemoControlPlane() {
  const store = seedStore();
  const draft: RoleDraft = {
    name: "Preserved ACME finance role",
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
  const applied = applyRoleDraft(store, {
    actorId: "hugo.admin",
    principalId: "emma.acme",
    draft,
  });
  const jit = requestJit(store, {
    requesterId: "emma.acme",
    principalId: "emma.acme",
    datasetId: "bw_vendor",
    capsuleId: "vendor-acme",
    purpose: "vendor-performance",
    contractId: "jit.vendor.bw-export",
    actions: ["view"],
    justification: "Preserve this pending request",
    requestedTtlMs: 60_000,
    now: 1_000,
  });
  const state = createApiControlState();
  state.roleRequests.push({
    id: "role-request-preserved",
    requesterId: "emma.acme",
    principalId: "emma.acme",
    status: "approved",
    draft,
    createdAt: 900,
    approvalPolicyVersion: 1,
    requiredApprovals: ["governance-admin"],
    approvals: [{
      reviewerId: "hugo.admin",
      reviewerRole: "governance-admin",
      decision: "approved",
      decidedAt: 950,
    }],
    reviewedAt: 950,
    reviewerId: "hugo.admin",
    applied,
  });
  state.jitMetadata.push({
    jitId: jit.id,
    justification: "Preserve this pending request",
    requestedTtlMs: 60_000,
  });
  store.appendAudit("hugo.admin", "test.legacy-snapshot", { preserve: true }, 1_100);

  store.personas.delete("data-owner");
  store.capsules.delete("data-governance-owner");
  store.principals.delete("dana.owner");
  store.principals.delete("iris.admin");
  store.memberships = store.memberships.filter((membership) =>
    membership.principalId !== "dana.owner"
    && membership.principalId !== "iris.admin"
    && membership.capsuleId !== "data-governance-owner"
  );
  store.contracts.delete("wh.data-owner");
  store.bindings = store.bindings.filter((binding) =>
    binding.contractId !== "wh.data-owner" && binding.capsuleId !== "data-governance-owner"
  );
  const warehouse = store.datasets.get("warehouse")!;
  const { ownerPrincipalIds: _legacyOwners, ...legacyWarehouse } = warehouse;
  store.datasets.set("warehouse", {
    ...legacyWarehouse,
    name: "Legacy shared warehouse",
    classification: "confidential",
    allowedFields: ["id", "product"],
  });
  for (const id of ["wh.l1", "wh.l2bw", "wh.l2bobj", "wh.obs", "wh.acme", "wh.globex"]) {
    const contract = store.contracts.get(id)!;
    store.contracts.set(id, { ...contract, allowFields: ["id"] });
  }

  return { store, state, customContractId: applied.contractId };
}
