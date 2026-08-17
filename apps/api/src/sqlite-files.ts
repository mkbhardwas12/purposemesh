import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export function prepareWritableSqlitePath(path: string): { created: boolean } {
  if (path === ":memory:") return { created: false };
  const parent = dirname(path);
  const parentExists = existsSync(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!parentExists) restrictMode(parent, 0o700);
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`SQLite path must be a regular file: ${path}`);
    }
    return { created: false };
  }
  const descriptor = openSync(path, "wx", 0o600);
  closeSync(descriptor);
  return { created: true };
}

export function assertExistingSqliteFile(path: string): void {
  if (path === ":memory:" || !existsSync(path)) {
    throw new Error(`production SQLite file does not exist: ${path}`);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`production SQLite path must be a regular file: ${path}`);
  }
}

export function restrictNewSqliteFiles(path: string, created: boolean): void {
  if (!created || path === ":memory:") return;
  restrictMode(path, 0o600);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${path}${suffix}`;
    if (existsSync(sidecar)) restrictMode(sidecar, 0o600);
  }
}

function restrictMode(path: string, mode: number): void {
  if (process.platform === "win32") return;
  chmodSync(path, mode);
}
