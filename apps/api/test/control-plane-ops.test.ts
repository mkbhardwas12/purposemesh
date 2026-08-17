import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedStore } from "@cca/core";
import {
  createApiControlState,
  SqliteControlPlaneRepository,
} from "../src/control-plane.js";
import {
  backupControlPlane,
  inspectControlPlaneDatabase,
  restoreControlPlane,
  verifyControlPlaneBackup,
} from "../src/control-plane-ops.js";

describe("control-plane snapshot operations", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates and verifies a private, repository-valid WAL-consistent backup", async () => {
    const directory = temporaryDirectory();
    const source = join(directory, "control.sqlite");
    const bundle = join(directory, "snapshot");
    provision(source);

    const result = await backupControlPlane(source, bundle);
    const verified = await verifyControlPlaneBackup(bundle);

    expect(result.snapshot.payloadSha256).toBe(verified.snapshot.payloadSha256);
    expect(verified.snapshot.storeVersion).toBe(3);
    expect(verified.snapshot.objects.principals).toBeGreaterThan(0);
    expect(verified.snapshot.objects.recertificationCampaigns).toBe(0);
    expect(verified.snapshot.objects.recertificationItems).toBe(0);
    expect(verified.snapshot.audit.sequence).toBe(verified.snapshot.audit.count);
    expect(existsSync(join(bundle, "control-plane.sqlite"))).toBe(true);
    expect(existsSync(join(bundle, "manifest.json"))).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(bundle).mode & 0o777).toBe(0o700);
      expect(statSync(join(bundle, "control-plane.sqlite")).mode & 0o777).toBe(0o600);
      expect(statSync(join(bundle, "manifest.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("detects manifest and snapshot tampering", async () => {
    const directory = temporaryDirectory();
    const source = join(directory, "control.sqlite");
    const bundle = join(directory, "snapshot");
    provision(source);
    await backupControlPlane(source, bundle);

    const manifestPath = join(bundle, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      databaseSha256: string;
    };
    manifest.databaseSha256 = "0".repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

    await expect(verifyControlPlaneBackup(bundle)).rejects.toThrow(/SHA-256 mismatch/);
  });

  it("restores an existing target transactionally and preserves a verified rollback bundle", async () => {
    const directory = temporaryDirectory();
    const source = join(directory, "control.sqlite");
    const bundle = join(directory, "snapshot");
    provision(source);
    const backedUp = await backupControlPlane(source, bundle);

    const repository = new SqliteControlPlaneRepository(source, { requireExisting: true });
    const current = repository.load("production")!;
    current.store.appendAudit("hugo.admin", "test.after-backup", { changed: true });
    repository.save(current.store, current.state);
    repository.close();
    const changed = await inspectControlPlaneDatabase(source);
    expect(changed.payloadSha256).not.toBe(backedUp.snapshot.payloadSha256);

    const restored = await restoreControlPlane({
      bundle,
      target: source,
      confirmedStopped: true,
    });

    expect(restored.created).toBe(false);
    expect(restored.restoredSnapshot.payloadSha256).toBe(backedUp.snapshot.payloadSha256);
    expect(restored.rollbackBundle).toBeDefined();
    const rollback = await verifyControlPlaneBackup(restored.rollbackBundle!);
    expect(rollback.snapshot.payloadSha256).toBe(changed.payloadSha256);
  });

  it("can provision a missing target but never overwrites a backup bundle", async () => {
    const directory = temporaryDirectory();
    const source = join(directory, "control.sqlite");
    const bundle = join(directory, "snapshot");
    const restoredPath = join(directory, "recovery", "control.sqlite");
    provision(source);
    const backedUp = await backupControlPlane(source, bundle);

    await expect(backupControlPlane(source, bundle)).rejects.toThrow(/already exists/);
    const restored = await restoreControlPlane({
      bundle,
      target: restoredPath,
      confirmedStopped: true,
    });

    expect(restored.created).toBe(true);
    expect(restored.rollbackBundle).toBeUndefined();
    expect(restored.restoredSnapshot.payloadSha256).toBe(backedUp.snapshot.payloadSha256);
  });

  it("requires an explicit stopped-writer confirmation and rejects symlink inputs", async () => {
    const directory = temporaryDirectory();
    const source = join(directory, "control.sqlite");
    const bundle = join(directory, "snapshot");
    provision(source);
    await backupControlPlane(source, bundle);

    await expect(restoreControlPlane({
      bundle,
      target: source,
      confirmedStopped: false,
    })).rejects.toThrow(/confirm-stopped/);

    if (process.platform !== "win32") {
      const linked = join(directory, "linked.sqlite");
      symlinkSync(source, linked);
      await expect(inspectControlPlaneDatabase(linked)).rejects.toThrow(/symbolic links/);
    }
  });

  it("rejects symlinked parents for sources, outputs, restore targets, rollbacks, and sidecars", async () => {
    if (process.platform === "win32") return;

    const directory = temporaryDirectory();
    const sourceParent = join(directory, "source-parent");
    const linkedSourceParent = join(directory, "source-parent-link");
    mkdirSync(sourceParent);
    const source = join(sourceParent, "control.sqlite");
    provision(source);
    symlinkSync(sourceParent, linkedSourceParent, "dir");

    await expect(
      inspectControlPlaneDatabase(join(linkedSourceParent, "control.sqlite")),
    ).rejects.toThrow(/symbolic links.*source-parent-link/);

    const bundle = join(directory, "snapshot");
    const backedUp = await backupControlPlane(source, bundle);

    const outputParent = join(directory, "output-parent");
    const linkedOutputParent = join(directory, "output-parent-link");
    mkdirSync(outputParent);
    symlinkSync(outputParent, linkedOutputParent, "dir");
    await expect(
      backupControlPlane(source, join(linkedOutputParent, "blocked-snapshot")),
    ).rejects.toThrow(/symbolic links.*output-parent-link/);
    expect(existsSync(join(outputParent, "blocked-snapshot"))).toBe(false);

    const targetParent = join(directory, "target-parent");
    const linkedTargetParent = join(directory, "target-parent-link");
    mkdirSync(targetParent);
    symlinkSync(targetParent, linkedTargetParent, "dir");
    await expect(restoreControlPlane({
      bundle,
      target: join(linkedTargetParent, "control.sqlite"),
      confirmedStopped: true,
    })).rejects.toThrow(/symbolic links.*target-parent-link/);
    expect(existsSync(join(targetParent, "control.sqlite"))).toBe(false);

    const rollbackParent = join(directory, "rollback-parent");
    const linkedRollbackParent = join(directory, "rollback-parent-link");
    mkdirSync(rollbackParent);
    symlinkSync(rollbackParent, linkedRollbackParent, "dir");
    await expect(restoreControlPlane({
      bundle,
      target: source,
      confirmedStopped: true,
      rollbackOut: join(linkedRollbackParent, "blocked-rollback"),
    })).rejects.toThrow(/symbolic links.*rollback-parent-link/);
    expect(existsSync(join(rollbackParent, "blocked-rollback"))).toBe(false);

    const sidecarSource = join(directory, "sidecar-source.sqlite");
    copyFileSync(backedUp.database, sidecarSource);
    const linkedSidecar = `${sidecarSource}-wal`;
    symlinkSync(join(directory, "missing-sidecar-target"), linkedSidecar);
    await expect(inspectControlPlaneDatabase(sidecarSource)).rejects.toThrow(
      /symbolic links.*sidecar-source\.sqlite-wal/,
    );
  });

  function temporaryDirectory(): string {
    // macOS exposes /var and /tmp through system symlinks. Use the canonical
    // physical temp path so these tests exercise only the symlinks they create.
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "cca-control-ops-test-"));
    directories.push(directory);
    return directory;
  }
});

function provision(path: string): void {
  const repository = new SqliteControlPlaneRepository(path);
  repository.save(seedStore(), createApiControlState());
  repository.close();
}
