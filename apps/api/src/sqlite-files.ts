import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";

/**
 * SQLite's Node binding reopens a pathname; it cannot take an already-open fd.
 * Accordingly, disk databases require a trusted POSIX directory chain: owned by
 * this UID/root, no symlinks, and no group/world writes (except sticky ancestors).
 * The final directory may not be shared-writable, even with the sticky bit.
 * Existing directory/file permissions are never repaired or relaxed here.
 *
 * This excludes other-UID path substitution, not a hostile process running as
 * the service UID/root, or an administrator changing mounts/ACLs. Those are part
 * of the trusted host boundary. Use a dedicated service UID and private volume.
 */
export function prepareWritableSqlitePath(path: string): { created: boolean } {
  if (path === ":memory:") return { created: false };
  const filename = validatePath(path);
  assertDirectoryChain(dirname(filename), true);
  assertSafeSidecars(filename);

  let descriptor: number;
  let created = false;
  try {
    // Creation itself decides whether the file exists. Never check then create,
    // truncate, follow a link, or retry creation after an existing file vanishes.
    descriptor = openSync(filename, fileFlags() | constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
    created = true;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    descriptor = openSync(filename, fileFlags() | constants.O_RDWR);
  }
  try {
    assertRegularFile(fstatSync(descriptor), filename);
  } finally {
    closeSync(descriptor);
  }
  return { created };
}

export function assertExistingSqliteFile(path: string): void {
  if (path === ":memory:") throw new Error(`production SQLite file does not exist: ${path}`);
  const filename = validatePath(path);
  try {
    assertDirectoryChain(dirname(filename), false);
    withRegularFile(filename, () => {});
    assertSafeSidecars(filename);
  } catch (error) {
    if (hasCode(error, "ENOENT")) throw new Error(`production SQLite file does not exist: ${path}`, { cause: error });
    throw error;
  }
}

export function restrictNewSqliteFiles(path: string, created: boolean): void {
  if (!created || path === ":memory:") return;
  const filename = validatePath(path);
  assertDirectoryChain(dirname(filename), false);
  // Change the opened inode, never a pathname that can be swapped for a link.
  withRegularFile(filename, (descriptor) => fchmodSync(descriptor, 0o600));
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    withRegularFile(`${filename}${suffix}`, (descriptor) => fchmodSync(descriptor, 0o600), true);
  }
}

function validatePath(path: string): string {
  // Reject ambiguous SQLite filenames and '..' before normalization: resolving
  // a/linked/../db could otherwise validate a different path than SQLite opens.
  if (!path || path.includes("\0") || path.startsWith("file:") || path.split(/[\\/]/).includes("..") || path.endsWith(sep)) {
    throw new Error("SQLite path must be an unambiguous file path without '..' components");
  }
  if (typeof process.getuid !== "function" || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    throw new Error("SQLite filesystem protection requires POSIX no-follow directory/file opens");
  }
  const filename = resolve(path);
  if (!isAbsolute(filename) || filename === parse(filename).root) throw new Error("SQLite path must name a file");
  return filename;
}

function assertDirectoryChain(parent: string, create: boolean): void {
  const root = parse(parent).root;
  const components = parent.slice(root.length).split(sep).filter(Boolean);
  let directory = root;
  for (let index = -1; index < components.length; index += 1) {
    if (index >= 0) directory = resolve(directory, components[index]!);
    if (create && index >= 0) {
      try {
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
    }
    // NOFOLLOW applies to each component, not merely the final file. Validating
    // ownership/mode before descending prevents untrusted ancestor replacement.
    const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(descriptor);
      const final = index === components.length - 1;
      if (!stat.isDirectory() || !trustedOwner(stat)) {
        throw new Error(`SQLite directory must be owned by the service UID or root: ${directory}`);
      }
      if ((stat.mode & 0o022) !== 0 && (final || (stat.mode & 0o1000) === 0)) {
        throw new Error(`SQLite directory must not be group/world-writable${final ? " (database parent)" : ""}: ${directory}`);
      }
    } finally {
      closeSync(descriptor);
    }
  }
}

function fileFlags(): number {
  // NONBLOCK ensures a malicious FIFO does not hang startup before fstat rejects it.
  return constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

function withRegularFile(path: string, use: (descriptor: number) => void, optional = false): void {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | fileFlags());
  } catch (error) {
    if (optional && hasCode(error, "ENOENT")) return;
    throw error;
  }
  try {
    assertRegularFile(fstatSync(descriptor), path);
    use(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertRegularFile(stat: Stats, path: string): void {
  if (!stat.isFile() || stat.nlink !== 1) throw new Error(`SQLite path must be a regular file with one link: ${path}`);
  if (!trustedOwner(stat) || (stat.mode & 0o022) !== 0) {
    throw new Error(`SQLite file must be owned by the service UID or root and not group/world-writable: ${path}`);
  }
}

function assertSafeSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) withRegularFile(`${path}${suffix}`, () => {}, true);
}

function trustedOwner(stat: Stats): boolean {
  return stat.uid === process.getuid!() || stat.uid === 0;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
