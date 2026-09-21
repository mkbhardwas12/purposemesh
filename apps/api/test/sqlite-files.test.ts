import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertExistingSqliteFile,
  prepareWritableSqlitePath,
  restrictNewSqliteFiles,
} from "../src/sqlite-files.js";

// Keep real filesystem operations but give deterministic race tests spyable
// bindings; native ESM namespace exports themselves are not configurable.
vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>() }));

describe.skipIf(process.platform === "win32")("SQLite filesystem boundary", () => {
  let directory: string;
  beforeEach(() => {
    // Canonicalize the OS-provided fixture root only, not application input.
    directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "cca-sqlite-files-test-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // Every test owns this newly created directory. Never follow links outside it.
    if (!directory || dirname(directory) !== fs.realpathSync(tmpdir()) || !basename(directory).startsWith("cca-sqlite-files-test-")) throw new Error("invalid test cleanup target");
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid test cleanup directory");
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("creates missing parents and a private file atomically", () => {
    const path = join(directory, "private", "nested", "data.sqlite");
    expect(prepareWritableSqlitePath(path)).toEqual({ created: true });
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(prepareWritableSqlitePath(path)).toEqual({ created: false });
  });

  it("preserves an existing SQLite database and its permissions", () => {
    const path = join(directory, "existing.sqlite");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('preserve me')");
    db.close();
    fs.chmodSync(path, 0o640);
    const before = fs.readFileSync(path);
    expect(prepareWritableSqlitePath(path)).toEqual({ created: false });
    assertExistingSqliteFile(path);
    restrictNewSqliteFiles(path, false);
    expect(fs.readFileSync(path)).toEqual(before);
    expect(fs.statSync(path).mode & 0o777).toBe(0o640);
  });

  it("does not create missing production files or parents", () => {
    const parent = join(directory, "missing");
    expect(() => assertExistingSqliteFile(join(parent, "db.sqlite"))).toThrow(/does not exist/);
    expect(fs.existsSync(parent)).toBe(false);
    expect(() => assertExistingSqliteFile(":memory:")).toThrow(/does not exist/);
    expect(prepareWritableSqlitePath(":memory:")).toEqual({ created: false });
  });

  it.each(["", "file:data.sqlite", "invalid\0.sqlite", "x/../data.sqlite", "data/"])("rejects ambiguous input %j", (path) => {
    expect(() => prepareWritableSqlitePath(path)).toThrow(/unambiguous/);
  });

  it.each([false, true])("rejects file symlinks including dangling links (dangling=%s)", (dangling) => {
    const target = join(directory, "target.sqlite");
    if (!dangling) fs.writeFileSync(target, "untouched", { mode: 0o600 });
    const linked = join(directory, "linked.sqlite");
    fs.symlinkSync(target, linked);
    expect(() => prepareWritableSqlitePath(linked)).toThrow();
    expect(() => assertExistingSqliteFile(linked)).toThrow();
    if (dangling) expect(fs.existsSync(target)).toBe(false);
    else expect(fs.readFileSync(target, "utf8")).toBe("untouched");
  });

  it("rejects symlinks anywhere in the parent chain before creating through them", () => {
    const real = join(directory, "real");
    fs.mkdirSync(real, { mode: 0o700 });
    const linked = join(directory, "linked");
    fs.symlinkSync(real, linked);
    const path = join(linked, "nested", "data.sqlite");
    expect(() => prepareWritableSqlitePath(path)).toThrow();
    expect(() => assertExistingSqliteFile(path)).toThrow();
    expect(fs.readdirSync(real)).toEqual([]);
  });

  it("rejects nonregular files and hard links", () => {
    const folder = join(directory, "not-a-file");
    fs.mkdirSync(folder, { mode: 0o700 });
    expect(() => prepareWritableSqlitePath(folder)).toThrow();
    expect(() => assertExistingSqliteFile(folder)).toThrow(/regular file/);
    const target = join(directory, "target.sqlite");
    fs.writeFileSync(target, "unchanged", { mode: 0o600 });
    const linked = join(directory, "hard.sqlite");
    fs.linkSync(target, linked);
    expect(() => prepareWritableSqlitePath(linked)).toThrow(/one link/);
    expect(() => assertExistingSqliteFile(linked)).toThrow(/one link/);
    expect(fs.readFileSync(target, "utf8")).toBe("unchanged");
  });

  it.each([0o770, 0o777, 0o1777])("rejects a shared-writable final directory (mode %i) without changing it", (mode) => {
    fs.chmodSync(directory, mode);
    expect(() => prepareWritableSqlitePath(join(directory, "db.sqlite"))).toThrow(/group\/world-writable/);
    expect(fs.statSync(directory).mode & 0o7777).toBe(mode);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("rejects a writable non-sticky ancestor before descending", () => {
    const shared = join(directory, "shared");
    fs.mkdirSync(shared, { mode: 0o700 });
    fs.chmodSync(shared, 0o777);
    expect(() => prepareWritableSqlitePath(join(shared, "new", "db.sqlite"))).toThrow(/group\/world-writable/);
    expect(fs.readdirSync(shared)).toEqual([]);
  });

  it("allows conventional 0755 owned volume directories without altering them", () => {
    fs.chmodSync(directory, 0o755);
    expect(prepareWritableSqlitePath(join(directory, "db.sqlite"))).toEqual({ created: true });
    expect(fs.statSync(directory).mode & 0o777).toBe(0o755);
  });

  it("rejects group/world-writable existing files without repairing permissions", () => {
    const path = join(directory, "db.sqlite");
    fs.writeFileSync(path, "preserved", { mode: 0o600 });
    fs.chmodSync(path, 0o666);
    expect(() => prepareWritableSqlitePath(path)).toThrow(/group\/world-writable/);
    expect(() => assertExistingSqliteFile(path)).toThrow(/group\/world-writable/);
    expect(fs.readFileSync(path, "utf8")).toBe("preserved");
    expect(fs.statSync(path).mode & 0o777).toBe(0o666);
  });

  it.each(["-wal", "-shm", "-journal"])("rejects unsafe existing sidecar %s before database creation", (suffix) => {
    const target = join(directory, "target");
    fs.writeFileSync(target, "preserved", { mode: 0o640 });
    const path = join(directory, "db.sqlite");
    fs.symlinkSync(target, `${path}${suffix}`);
    expect(() => prepareWritableSqlitePath(path)).toThrow();
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("preserved");
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  });

  it("preserves a file won by a concurrent creator", () => {
    const path = join(directory, "db.sqlite");
    const realOpen = fs.openSync;
    let raced = false;
    vi.spyOn(fs, "openSync").mockImplementation((name, flags, mode) => {
      if (name === path && typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0 && !raced) {
        raced = true;
        const fd = realOpen(path, "wx", 0o600);
        fs.writeSync(fd, "concurrent winner");
        fs.closeSync(fd);
      }
      return realOpen(name, flags, mode);
    });
    expect(prepareWritableSqlitePath(path)).toEqual({ created: false });
    expect(raced).toBe(true);
    expect(fs.readFileSync(path, "utf8")).toBe("concurrent winner");
  });

  it("rejects a link substituted between exclusive-create failure and existing-file open", () => {
    const path = join(directory, "db.sqlite");
    const moved = join(directory, "moved.sqlite");
    const target = join(directory, "target.sqlite");
    fs.writeFileSync(path, "original", { mode: 0o600 });
    fs.writeFileSync(target, "preserved", { mode: 0o600 });
    const realOpen = fs.openSync;
    let raced = false;
    vi.spyOn(fs, "openSync").mockImplementation((name, flags, mode) => {
      if (name === path && typeof flags === "number" && (flags & fs.constants.O_EXCL) === 0 && !raced) {
        raced = true;
        fs.renameSync(path, moved);
        fs.symlinkSync(target, path);
      }
      return realOpen(name, flags, mode);
    });
    expect(() => prepareWritableSqlitePath(path)).toThrow();
    expect(raced).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("preserved");
    expect(fs.readFileSync(moved, "utf8")).toBe("original");
  });

  it("fails closed rather than recreating a file removed during the open race", () => {
    const path = join(directory, "db.sqlite");
    const moved = join(directory, "moved.sqlite");
    fs.writeFileSync(path, "original", { mode: 0o600 });
    const realOpen = fs.openSync;
    let raced = false;
    vi.spyOn(fs, "openSync").mockImplementation((name, flags, mode) => {
      if (name === path && typeof flags === "number" && (flags & fs.constants.O_EXCL) === 0 && !raced) {
        raced = true;
        fs.renameSync(path, moved);
      }
      return realOpen(name, flags, mode);
    });
    expect(() => prepareWritableSqlitePath(path)).toThrow();
    expect(raced).toBe(true);
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.readFileSync(moved, "utf8")).toBe("original");
  });

  it("uses the opened descriptor for chmod even if its pathname is replaced", () => {
    const path = join(directory, "db.sqlite");
    const moved = join(directory, "moved.sqlite");
    const target = join(directory, "target.sqlite");
    fs.writeFileSync(path, "original", { mode: 0o640 });
    fs.writeFileSync(target, "preserved", { mode: 0o644 });
    const realChmod = fs.fchmodSync;
    let raced = false;
    vi.spyOn(fs, "fchmodSync").mockImplementation((descriptor, mode) => {
      if (!raced) {
        raced = true;
        fs.renameSync(path, moved);
        fs.symlinkSync(target, path);
      }
      realChmod(descriptor, mode);
    });
    restrictNewSqliteFiles(path, true);
    expect(raced).toBe(true);
    expect(fs.statSync(moved).mode & 0o777).toBe(0o600);
    const targetDescriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      // Inspect and read the same inode, even in the regression test.
      expect(fs.fstatSync(targetDescriptor).mode & 0o777).toBe(0o644);
      expect(fs.readFileSync(targetDescriptor, "utf8")).toBe("preserved");
    } finally {
      fs.closeSync(targetDescriptor);
    }
  });
});
