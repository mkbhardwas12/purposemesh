import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { verifyAccessToken } from "../src/jwt.js";

const environment: NodeJS.ProcessEnv = {
  CCA_MODE: "production",
  CCA_JWT_SECRET: "jwt-regression-test-secret-with-at-least-32-characters",
};
const key = new TextEncoder().encode(environment.CCA_JWT_SECRET);
const claims = {
  sub: "emma.acme",
  persona: "consumer",
  capsules: ["finance-acme"],
  authorizationFingerprint: "a".repeat(64),
  kind: "human",
  authenticationAssurance: "password",
  purpose: "vendor-performance",
};

function tokenBuilder() {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("cca-control-plane")
    .setAudience("cca-api")
    .setJti("jwt-regression-token")
    .setIssuedAt()
    .setExpirationTime("15m");
}

describe("JWT verification policy across dependency upgrades", () => {
  it("accepts a valid purpose-bound production token", async () => {
    const token = await tokenBuilder().sign(key);
    await expect(verifyAccessToken(token, environment)).resolves.toEqual(claims);
  });

  it.each([
    { claim: "aud", value: "another-api" },
    { claim: "iss", value: "another-issuer" },
  ])("rejects a correctly signed token with the wrong $claim", async ({ claim, value }) => {
    const builder = tokenBuilder();
    if (claim === "aud") builder.setAudience(value);
    else builder.setIssuer(value);
    const token = await builder.sign(key);
    await expect(verifyAccessToken(token, environment)).rejects.toMatchObject({
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
      claim,
    });
  });

  it("rejects a correctly signed algorithm outside the HS256 allowlist", async () => {
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS384" })
      .setIssuer("cca-control-plane")
      .setAudience("cca-api")
      .setJti("wrong-algorithm-token")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(key);
    await expect(verifyAccessToken(token, environment)).rejects.toMatchObject({
      code: "ERR_JOSE_ALG_NOT_ALLOWED",
    });
  });

  it("rejects a correctly signed expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await tokenBuilder().setIssuedAt(now - 120).setExpirationTime(now - 60).sign(key);
    await expect(verifyAccessToken(token, environment)).rejects.toMatchObject({
      code: "ERR_JWT_EXPIRED",
      claim: "exp",
    });
  });

  it("rejects a correctly signed token before its not-before time", async () => {
    const token = await tokenBuilder().setNotBefore("5m").sign(key);
    await expect(verifyAccessToken(token, environment)).rejects.toMatchObject({
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
      claim: "nbf",
    });
  });

  it("rejects a token signed by a different key", async () => {
    const token = await tokenBuilder().sign(new TextEncoder().encode("untrusted-key-with-at-least-32-characters"));
    await expect(verifyAccessToken(token, environment)).rejects.toMatchObject({
      code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    });
  });
});
