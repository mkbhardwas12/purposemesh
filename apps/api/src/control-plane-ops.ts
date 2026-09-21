import { createHash } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { SqliteControlPlaneRepository } from "./control-plane.js";

const BACKUP_FORMAT = "cca-control-plane-backup-v1" as const;
const DATABASE_FILE = "control-plane.sqlite";
const MANIFEST_FILE = "manifest.json";

export type ControlPlaneSnapshotSummary = {
  updatedAt: number;
  envelopeVersion: number;
  storeVersion: number;
  payloadSha256: string;
  audit: {
    count: number;
    sequence: number;
    headHash: string;
  };
  objects: {
    personas: number;
    capsules: number;
    principals: number;
    memberships: number;
    datasets: number;
    contracts: number;
    bindings: number;
    jitGrants: number;
    roleRequests: number;
    roleRequestApprovals: number;
    jitRequestMetadata: number;
    recertificationCampaigns: number;
    recertificationItems: number;
  };
};

export type ControlPlaneBackupManifest = {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  databaseFile: typeof DATABASE_FILE;
  sourceFile: string;
  databaseBytes: number;
  databaseSha256: string;
  snapshot: ControlPlaneSnapshotSummary;
};

export type BackupResult = {
  bundle: string;
  database: string;
  manifest: string;
  snapshot: ControlPlaneSnapshotSummary;
};

export type VerifyBundleResult = BackupResult & {
  databaseSha256: string;
};

export type RestoreResult = {
  target: string;
  created: boolean;
  rollbackBundle?: string;
  restoredSnapshot: ControlPlaneSnapshotSummary;
};

type StateRow = {
  payload: string;
  updated_at: number;
};

/**
 * Validates SQLite integrity and then loads a transactionally consistent clone
 * through the production repository parser. The source is never opened writable.
 */
export async function inspectControlPlaneDatabase(path: string): Promise<ControlPlaneSnapshotSummary> {
  const databasePath = resolve(path);
  assertRegularFile(databasePath, "control-plane database");
  assertSafeSqliteSidecars(databasePath);

  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    source.exec("PRAGMA query_only = ON");
    source.exec("PRAGMA busy_timeout = 5000");
    assertSqliteIntegrity(source);
  } finally {
    source.close();
  }

  const validationDirectory = mkdtempSync(join(realpathSync(tmpdir()), "cca-control-validate-"));
  const validationPath = join(validationDirectory, DATABASE_FILE);
  try {
    const validationSource = new DatabaseSync(databasePath, { readOnly: true });
    try {
      validationSource.exec("PRAGMA query_only = ON");
      validationSource.exec("PRAGMA busy_timeout = 5000");
      await backup(validationSource, validationPath);
    } finally {
      validationSource.close();
    }
    restrictFile(validationPath);

    const validationDatabase = new DatabaseSync(validationPath, { readOnly: true });
    let row: StateRow;
    try {
      validationDatabase.exec("PRAGMA query_only = ON");
      assertSqliteIntegrity(validationDatabase);
      row = readStateRow(validationDatabase);
    } finally {
      validationDatabase.close();
    }
    const envelope = parseEnvelopeHeader(row.payload);

    const repository = new SqliteControlPlaneRepository(validationPath, { requireExisting: true });
    try {
      const loaded = repository.load("production");
      if (!loaded) throw new Error("control-plane database has no persisted snapshot");
      const snapshot = loaded.store.snapshot();
      const auditHead = snapshot.audit.at(-1);
      return {
        updatedAt: row.updated_at,
        envelopeVersion: envelope.version,
        storeVersion: snapshot.version,
        payloadSha256: sha256Text(row.payload),
        audit: {
          count: snapshot.audit.length,
          sequence: snapshot.seq,
          headHash: auditHead?.hash ?? "genesis",
        },
        objects: {
          personas: snapshot.personas.length,
          capsules: snapshot.capsules.length,
          principals: snapshot.principals.length,
          memberships: snapshot.memberships.length,
          datasets: snapshot.datasets.length,
          contracts: snapshot.contracts.length,
          bindings: snapshot.bindings.length,
          jitGrants: snapshot.jit.length,
          roleRequests: loaded.state.roleRequests.length,
          roleRequestApprovals: loaded.state.roleRequests.reduce(
            (count, request) => count + request.approvals.length,
            0,
          ),
          jitRequestMetadata: loaded.state.jitMetadata.length,
          recertificationCampaigns: loaded.state.recertifications.length,
          recertificationItems: loaded.state.recertifications.reduce(
            (count, campaign) => count + campaign.items.length,
            0,
          ),
        },
      };
    } finally {
      repository.close();
    }
  } finally {
    rmSync(validationDirectory, { recursive: true, force: true });
  }
}

/** Creates a WAL-consistent, owner-readable-only backup bundle. */
export async function backupControlPlane(source: string, out: string): Promise<BackupResult> {
  const sourcePath = resolve(source);
  const bundlePath = resolve(out);
  assertRegularFile(sourcePath, "control-plane database");
  assertSafeSqliteSidecars(sourcePath);
  assertNoSymlinkComponents(bundlePath);
  if (existsSync(bundlePath)) throw new Error(`backup destination already exists: ${bundlePath}`);
  createPrivateDirectory(bundlePath);

  const databasePath = join(bundlePath, DATABASE_FILE);
  const manifestPath = join(bundlePath, MANIFEST_FILE);
  let completed = false;
  try {
    const sourceDatabase = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      sourceDatabase.exec("PRAGMA query_only = ON");
      sourceDatabase.exec("PRAGMA busy_timeout = 5000");
      await backup(sourceDatabase, databasePath);
    } finally {
      sourceDatabase.close();
    }
    restrictFile(databasePath);

    const snapshot = await inspectControlPlaneDatabase(databasePath);
    const manifest: ControlPlaneBackupManifest = {
      format: BACKUP_FORMAT,
      createdAt: new Date().toISOString(),
      databaseFile: DATABASE_FILE,
      sourceFile: basename(sourcePath),
      databaseBytes: statSync(databasePath).size,
      databaseSha256: await sha256File(databasePath),
      snapshot,
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    restrictFile(manifestPath);
    completed = true;
    return { bundle: bundlePath, database: databasePath, manifest: manifestPath, snapshot };
  } finally {
    if (!completed) rmSync(bundlePath, { recursive: true, force: true });
  }
}

/** Verifies manifest hashes plus the same domain invariants used on production load. */
export async function verifyControlPlaneBackup(bundle: string): Promise<VerifyBundleResult> {
  const bundlePath = resolve(bundle);
  assertDirectory(bundlePath, "backup bundle");
  const databasePath = join(bundlePath, DATABASE_FILE);
  const manifestPath = join(bundlePath, MANIFEST_FILE);
  assertRegularFile(databasePath, "backup database");
  assertRegularFile(manifestPath, "backup manifest");

  const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
  const hashBefore = await sha256File(databasePath);
  const snapshot = await inspectControlPlaneDatabase(databasePath);
  const hashAfter = await sha256File(databasePath);
  if (hashBefore !== hashAfter) throw new Error("backup database changed while it was being verified");

  const bytes = statSync(databasePath).size;
  if (bytes !== manifest.databaseBytes) {
    throw new Error(`backup size mismatch: expected ${manifest.databaseBytes}, received ${bytes}`);
  }
  if (hashAfter !== manifest.databaseSha256) throw new Error("backup database SHA-256 mismatch");
  if (snapshot.payloadSha256 !== manifest.snapshot.payloadSha256) {
    throw new Error("backup snapshot payload SHA-256 mismatch");
  }
  if (!sameSnapshotIdentity(snapshot, manifest.snapshot)) {
    throw new Error("backup snapshot metadata does not match the manifest");
  }

  return {
    bundle: bundlePath,
    database: databasePath,
    manifest: manifestPath,
    databaseSha256: hashAfter,
    snapshot,
  };
}

/**
 * Restores only the repository-owned control_plane_state row. Existing targets
 * receive an automatic rollback bundle before the transaction begins.
 */
export async function restoreControlPlane(options: {
  bundle: string;
  target: string;
  confirmedStopped: boolean;
  rollbackOut?: string;
}): Promise<RestoreResult> {
  if (!options.confirmedStopped) {
    throw new Error("restore refused: stop every API writer and pass --confirm-stopped");
  }

  const verified = await verifyControlPlaneBackup(options.bundle);
  const targetPath = resolve(options.target);
  assertSafeSqliteSidecars(targetPath);
  const backupRow = readStateRowFromPath(verified.database);
  if (sha256Text(backupRow.payload) !== verified.snapshot.payloadSha256) {
    throw new Error("backup snapshot changed after verification");
  }

  if (!existsSync(targetPath)) {
    ensurePrivateParent(dirname(targetPath));
    copyFileSync(verified.database, targetPath, fsConstants.COPYFILE_EXCL);
    restrictFile(targetPath);
    try {
      const restoredSnapshot = await inspectControlPlaneDatabase(targetPath);
      assertRestoredIdentity(restoredSnapshot, verified.snapshot);
      return { target: targetPath, created: true, restoredSnapshot };
    } catch (error) {
      if (existsSync(targetPath)) unlinkSync(targetPath);
      throw error;
    }
  }

  assertRegularFile(targetPath, "restore target");
  await inspectControlPlaneDatabase(targetPath);
  const rollbackPath = resolve(options.rollbackOut ?? defaultRollbackPath(targetPath));
  const rollback = await backupControlPlane(targetPath, rollbackPath);
  const previousRow = readStateRowFromPath(targetPath);

  let stateWritten = false;
  try {
    writeStateRow(targetPath, backupRow);
    stateWritten = true;
    const restoredSnapshot = await inspectControlPlaneDatabase(targetPath);
    assertRestoredIdentity(restoredSnapshot, verified.snapshot);
    return {
      target: targetPath,
      created: false,
      rollbackBundle: rollback.bundle,
      restoredSnapshot,
    };
  } catch (error) {
    if (!stateWritten) throw error;
    try {
      writeStateRow(targetPath, previousRow);
      await inspectControlPlaneDatabase(targetPath);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `restore verification failed and automatic rollback failed; recover from ${rollback.bundle}`,
      );
    }
    throw new Error(`restore verification failed; the previous snapshot was restored from memory`, {
      cause: error,
    });
  }
}

function assertRestoredIdentity(
  actual: ControlPlaneSnapshotSummary,
  expected: ControlPlaneSnapshotSummary,
): void {
  if (!sameSnapshotIdentity(actual, expected)) {
    throw new Error("restored snapshot does not match the verified backup");
  }
}

function sameSnapshotIdentity(
  left: ControlPlaneSnapshotSummary,
  right: ControlPlaneSnapshotSummary,
): boolean {
  return left.updatedAt === right.updatedAt
    && left.envelopeVersion === right.envelopeVersion
    && left.storeVersion === right.storeVersion
    && left.payloadSha256 === right.payloadSha256
    && left.audit.count === right.audit.count
    && left.audit.sequence === right.audit.sequence
    && left.audit.headHash === right.audit.headHash
    && JSON.stringify(left.objects) === JSON.stringify(right.objects);
}

function readStateRowFromPath(path: string): StateRow {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    return readStateRow(db);
  } finally {
    db.close();
  }
}

function readStateRow(db: DatabaseSync): StateRow {
  const table = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'control_plane_state'")
    .get() as { name: string } | undefined;
  if (!table) throw new Error("control-plane database is missing the state table");
  const row = db
    .prepare("SELECT payload, updated_at FROM control_plane_state WHERE id = 1")
    .get() as StateRow | undefined;
  if (!row) throw new Error("control-plane database has no persisted snapshot");
  if (typeof row.payload !== "string" || !Number.isSafeInteger(row.updated_at) || row.updated_at < 0) {
    throw new Error("control-plane state row is malformed");
  }
  return row;
}

function writeStateRow(path: string, row: StateRow): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN EXCLUSIVE");
    try {
      const result = db
        .prepare("UPDATE control_plane_state SET payload = ?, updated_at = ? WHERE id = 1")
        .run(row.payload, row.updated_at);
      if (result.changes !== 1) throw new Error("restore target has no control-plane state row");
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function assertSqliteIntegrity(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
  const messages = rows.flatMap((row) => Object.values(row));
  if (messages.length !== 1 || messages[0] !== "ok") {
    throw new Error(`SQLite integrity check failed: ${messages.join("; ") || "no result"}`);
  }
}

function parseEnvelopeHeader(payload: string): { version: number } {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    throw new Error("control-plane snapshot payload is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("control-plane snapshot envelope is malformed");
  }
  const version = (value as Record<string, unknown>).version;
  if (!Number.isSafeInteger(version)) throw new Error("control-plane snapshot envelope version is malformed");
  return { version: version as number };
}

function parseManifest(text: string): ControlPlaneBackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("backup manifest is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("backup manifest is malformed");
  }
  const manifest = value as Partial<ControlPlaneBackupManifest>;
  if (manifest.format !== BACKUP_FORMAT || manifest.databaseFile !== DATABASE_FILE) {
    throw new Error("unsupported backup manifest format");
  }
  if (typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error("backup manifest has an invalid creation time");
  }
  if (typeof manifest.sourceFile !== "string" || !manifest.sourceFile.trim()) {
    throw new Error("backup manifest has an invalid source file");
  }
  if (!Number.isSafeInteger(manifest.databaseBytes) || (manifest.databaseBytes ?? 0) <= 0) {
    throw new Error("backup manifest has an invalid database size");
  }
  if (!isSha256(manifest.databaseSha256)) throw new Error("backup manifest has an invalid database hash");
  if (!isSnapshotSummary(manifest.snapshot)) throw new Error("backup manifest has invalid snapshot metadata");
  return manifest as ControlPlaneBackupManifest;
}

function isSnapshotSummary(value: unknown): value is ControlPlaneSnapshotSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Partial<ControlPlaneSnapshotSummary>;
  if (!Number.isSafeInteger(summary.updatedAt) || (summary.updatedAt ?? -1) < 0) return false;
  if (!Number.isSafeInteger(summary.envelopeVersion) || !Number.isSafeInteger(summary.storeVersion)) return false;
  if (!isSha256(summary.payloadSha256)) return false;
  if (!summary.audit || typeof summary.audit !== "object") return false;
  if (!Number.isSafeInteger(summary.audit.count) || !Number.isSafeInteger(summary.audit.sequence)) return false;
  if (typeof summary.audit.headHash !== "string" || !summary.audit.headHash) return false;
  if (!summary.objects || typeof summary.objects !== "object") return false;
  return Object.values(summary.objects).every((count) => Number.isSafeInteger(count) && count >= 0);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function defaultRollbackPath(target: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return join(dirname(target), "backups", `${basename(target)}.pre-restore-${stamp}`);
}

function createPrivateDirectory(path: string): void {
  assertNoSymlinkComponents(path);
  ensurePrivateParent(dirname(path));
  assertNoSymlinkComponents(path);
  mkdirSync(path, { recursive: false, mode: 0o700 });
  assertDirectory(path, "created private directory");
  restrictDirectory(path);
}

function ensurePrivateParent(path: string): void {
  assertNoSymlinkComponents(path);
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  assertDirectory(path, "parent directory");
}

function assertRegularFile(path: string, label: string): void {
  assertNoSymlinkComponents(path);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
}

function assertDirectory(path: string, label: string): void {
  assertNoSymlinkComponents(path);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
}

function assertNoSymlinkComponents(path: string): void {
  const candidate = resolve(path);
  const components: string[] = [];
  let component = candidate;
  while (true) {
    components.push(component);
    const parent = dirname(component);
    if (parent === component) break;
    component = parent;
  }

  for (const existingComponent of components.reverse()) {
    const stat = lstatIfExists(existingComponent);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error(
        `symbolic links are not allowed in control-plane operation paths: ${existingComponent}`,
      );
    }
  }
}

function assertSafeSqliteSidecars(path: string): void {
  assertNoSymlinkComponents(path);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${path}${suffix}`;
    assertNoSymlinkComponents(sidecar);
    const stat = lstatIfExists(sidecar);
    if (!stat) continue;
    if (!stat.isFile()) {
      throw new Error(`SQLite sidecar must be a regular file: ${sidecar}`);
    }
  }
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function restrictFile(path: string): void {
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function restrictDirectory(path: string): void {
  if (process.platform !== "win32") chmodSync(path, 0o700);
}
