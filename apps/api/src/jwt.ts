import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

const DEMO_SECRET = "cca-demo-only-secret-not-for-production";
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 60 * 60;
const MAX_IAT_FUTURE_SKEW_SECONDS = 60;

export type RuntimeMode = "demo" | "test" | "production";

export type AccessToken = {
  sub: string;
  persona: string;
  capsules: string[];
  /** Hash of the principal's exact live assignment identities at issuance time. */
  authorizationFingerprint: string;
  kind: string;
  purpose?: string;
  /** Trusted claim set by the token issuer, never accepted from an API request body. */
  authenticationAssurance?: "password" | "mfa" | "phishing-resistant";
};

export function readRuntimeMode(env: NodeJS.ProcessEnv = process.env): RuntimeMode {
  if (env.CCA_MODE === "demo" || env.CCA_MODE === "test" || env.CCA_MODE === "production") {
    return env.CCA_MODE;
  }
  if (env.NODE_ENV === "test") return "test";
  return "production";
}

export function assertJwtConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  signingSecret(env);
}

function signingSecret(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const configured = env.CCA_JWT_SECRET?.trim();
  if (configured) {
    if (readRuntimeMode(env) === "production") {
      if (configured === DEMO_SECRET) {
        throw new Error("CCA_JWT_SECRET must not use the bundled demonstration secret in production");
      }
      if (configured.length < 32) {
        throw new Error("CCA_JWT_SECRET must contain at least 32 characters in production");
      }
    }
    return new TextEncoder().encode(configured);
  }
  const mode = readRuntimeMode(env);
  if (mode !== "demo" && mode !== "test") {
    throw new Error("CCA_JWT_SECRET is required in production");
  }
  return new TextEncoder().encode(DEMO_SECRET);
}

export async function signAccessToken(claims: AccessToken, ttl = "15m"): Promise<string> {
  return new SignJWT({ ...claims, authenticationAssurance: claims.authenticationAssurance ?? "password" })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("cca-api")
    .setIssuer("cca-control-plane")
    .setSubject(claims.sub)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(signingSecret());
}

export async function verifyAccessToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AccessToken> {
  const mode = readRuntimeMode(env);
  const { payload } = await jwtVerify(token, signingSecret(env), {
    audience: "cca-api",
    issuer: "cca-control-plane",
    algorithms: ["HS256"],
    requiredClaims: ["sub", "exp", "iat", "jti"],
  });
  const now = Math.floor(Date.now() / 1000);
  if (
    typeof payload.sub !== "string"
    || !payload.sub.trim()
    || typeof payload.persona !== "string"
    || !payload.persona.trim()
    || !Array.isArray(payload.capsules)
    || payload.capsules.some((capsule) => typeof capsule !== "string")
    || typeof payload.authorizationFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(payload.authorizationFingerprint)
    || (payload.kind !== "human" && payload.kind !== "workload")
    || !["password", "mfa", "phishing-resistant"].includes(String(payload.authenticationAssurance))
    || typeof payload.jti !== "string"
    || !payload.jti.trim()
    || !Number.isSafeInteger(payload.iat)
    || !Number.isSafeInteger(payload.exp)
    || payload.exp! <= payload.iat!
    || payload.exp! - payload.iat! > MAX_ACCESS_TOKEN_LIFETIME_SECONDS
    || payload.iat! > now + MAX_IAT_FUTURE_SKEW_SECONDS
    || (mode === "production" && payload.purpose === undefined)
    || (payload.purpose !== undefined && (
      typeof payload.purpose !== "string"
      || !payload.purpose.trim()
      || payload.purpose !== payload.purpose.trim()
    ))
  ) {
    throw new Error("invalid access-token claims");
  }
  return {
    sub: payload.sub,
    persona: payload.persona,
    capsules: payload.capsules as string[],
    authorizationFingerprint: payload.authorizationFingerprint,
    kind: payload.kind,
    purpose: payload.purpose,
    authenticationAssurance: payload.authenticationAssurance as AccessToken["authenticationAssurance"],
  };
}
