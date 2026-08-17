import {
  backupControlPlane,
  inspectControlPlaneDatabase,
  restoreControlPlane,
  verifyControlPlaneBackup,
} from "./control-plane-ops.js";

const HELP = `PurposeMesh control-plane snapshot operations

Usage:
  npm run ops:control-plane -- backup --source <sqlite> --out <bundle-dir>
  npm run ops:control-plane -- verify --bundle <bundle-dir>
  npm run ops:control-plane -- verify --database <sqlite>
  npm run ops:control-plane -- restore --bundle <bundle-dir> --target <sqlite> --confirm-stopped [--rollback-out <bundle-dir>]

Safety:
  backup uses SQLite's online backup API and captures a WAL-consistent snapshot.
  restore refuses to run without --confirm-stopped and creates a rollback bundle
  before changing an existing target. Existing files and backup bundles are never
  silently overwritten, and symlink paths are rejected.
`;

export async function runControlPlaneOps(
  argv: string[],
  output: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  try {
    if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
      output.log(HELP);
      return 0;
    }
    const [command, ...args] = argv;
    const flags = parseFlags(args);

    if (command === "backup") {
      assertOnlyFlags(flags, ["source", "out"]);
      const result = await backupControlPlane(required(flags, "source"), required(flags, "out"));
      output.log(JSON.stringify({ operation: "backup", ok: true, ...result }, null, 2));
      return 0;
    }

    if (command === "verify") {
      assertOnlyFlags(flags, ["bundle", "database"]);
      const bundle = flags.get("bundle");
      const database = flags.get("database");
      if ((bundle === undefined) === (database === undefined)) {
        throw new Error("verify requires exactly one of --bundle or --database");
      }
      const result = bundle
        ? await verifyControlPlaneBackup(stringFlag(bundle, "bundle"))
        : {
            database: stringFlag(database, "database"),
            snapshot: await inspectControlPlaneDatabase(stringFlag(database, "database")),
          };
      output.log(JSON.stringify({ operation: "verify", ok: true, ...result }, null, 2));
      return 0;
    }

    if (command === "restore") {
      assertOnlyFlags(flags, ["bundle", "target", "confirm-stopped", "rollback-out"]);
      const confirmedStopped = flags.get("confirm-stopped") === true;
      const rollbackOut = flags.get("rollback-out");
      const result = await restoreControlPlane({
        bundle: required(flags, "bundle"),
        target: required(flags, "target"),
        confirmedStopped,
        rollbackOut: rollbackOut === undefined ? undefined : stringFlag(rollbackOut, "rollback-out"),
      });
      output.log(JSON.stringify({ operation: "restore", ok: true, ...result }, null, 2));
      return 0;
    }

    throw new Error(`unknown command: ${command ?? ""}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.error(JSON.stringify({ operation: argv[0] ?? "help", ok: false, error: message }, null, 2));
    return 1;
  }
}

type FlagValue = string | true;

function parseFlags(args: string[]): Map<string, FlagValue> {
  const flags = new Map<string, FlagValue>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--") || token.length === 2) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (flags.has(name)) throw new Error(`duplicate flag: --${name}`);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(name, true);
    } else {
      flags.set(name, next);
      index += 1;
    }
  }
  return flags;
}

function assertOnlyFlags(flags: Map<string, FlagValue>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const name of flags.keys()) {
    if (!allowedSet.has(name)) throw new Error(`unknown flag: --${name}`);
  }
}

function required(flags: Map<string, FlagValue>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) throw new Error(`missing required flag: --${name}`);
  return stringFlag(value, name);
}

function stringFlag(value: FlagValue | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} requires a value`);
  return value;
}

process.exitCode = await runControlPlaneOps(process.argv.slice(2));
