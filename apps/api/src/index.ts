import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadOrInitializeControlPlane, SqliteControlPlaneRepository } from "./control-plane.js";
import { assertJwtConfiguration, readRuntimeMode } from "./jwt.js";
import { openWarehouse } from "./warehouse.js";

const mode = readRuntimeMode();
assertJwtConfiguration();

const port = integerEnv("PORT", 8787, 1, 65_535);
const host = process.env.HOST?.trim() || (mode === "production" ? "0.0.0.0" : "127.0.0.1");
const rows = mode === "production" ? 0 : integerEnv("CCA_FACT_ROWS", 100_000, 100_000, 10_000_000);
const dataDirectory = fileURLToPath(new URL("../../../data", import.meta.url));
const warehousePath = resolve(process.env.CCA_DB?.trim() || join(dataDirectory, "cca.sqlite"));
const controlPlanePath = resolve(
  process.env.CCA_CONTROL_DB?.trim() || join(dataDirectory, "cca-control.sqlite"),
);
if (warehousePath === controlPlanePath) {
  throw new Error("CCA_DB and CCA_CONTROL_DB must be different files");
}

const corsOrigins = csvEnv("CCA_CORS_ORIGINS");
if (mode === "production" && corsOrigins.length === 0) {
  throw new Error("CCA_CORS_ORIGINS must contain at least one production console origin");
}

const repository = new SqliteControlPlaneRepository(controlPlanePath, {
  requireExisting: mode === "production",
});
let controlPlane: ReturnType<typeof loadOrInitializeControlPlane>;
try {
  controlPlane = loadOrInitializeControlPlane(repository, mode);
} catch (error) {
  repository.close();
  throw error;
}
const { store, state } = controlPlane;

let warehouse: ReturnType<typeof openWarehouse>;
try {
  warehouse = openWarehouse({ path: warehousePath, rows, readOnly: mode === "production" });
} catch (error) {
  repository.close();
  throw error;
}
const app = buildApp(store, {
  warehouse,
  state,
  persistence: repository,
  ownWarehouse: true,
  ownPersistence: true,
  demoMode: mode !== "production",
  logger: true,
  logLevel: process.env.CCA_LOG_LEVEL?.trim() || "info",
  corsOrigins: corsOrigins.length > 0 ? corsOrigins : undefined,
  trustProxy: booleanEnv("CCA_TRUST_PROXY", false),
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
  } catch (error) {
    app.log.error({ err: error }, "graceful shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port, host });
  app.log.info(
    { host, port, mode, warehousePath, controlPlanePath, warehouseRows: warehouse.count() },
    "PurposeMesh control plane ready",
  );
} catch (error) {
  app.log.error({ err: error }, "PurposeMesh control plane failed to start");
  await app.close();
  process.exitCode = 1;
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function csvEnv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (new Set(values).size !== values.length) throw new Error(`${name} contains duplicate values`);
  for (const value of values) {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`${name} values must use http or https`);
    }
    if (url.origin !== value) throw new Error(`${name} values must be origins without paths`);
  }
  return values;
}
