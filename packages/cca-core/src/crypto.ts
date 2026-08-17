import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

export const DEMO_PASSWORD = "cca-demo";

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  return [
    "scrypt",
    "v1",
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export function verifyPassword(password: string, expected: string): boolean {
  const [algorithm, version, n, r, p, encodedSalt, encodedHash, ...extra] = expected.split("$");
  if (
    algorithm !== "scrypt"
    || version !== "v1"
    || Number(n) !== SCRYPT_N
    || Number(r) !== SCRYPT_R
    || Number(p) !== SCRYPT_P
    || !encodedSalt
    || !encodedHash
    || extra.length > 0
  ) {
    return false;
  }

  try {
    const salt = Buffer.from(encodedSalt, "base64url");
    const stored = Buffer.from(encodedHash, "base64url");
    if (salt.length !== 16 || stored.length !== SCRYPT_KEY_LENGTH) return false;
    const derived = scryptSync(password, salt, stored.length, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAX_MEMORY,
    });
    return timingSafeEqual(derived, stored);
  } catch {
    return false;
  }
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
