// 비밀번호 해시·검증·임시 비밀번호(Design §7.4 '비밀번호 규칙', Plan M3·D15).
// 순수 모듈이다. WebCrypto만 쓰고 앱의 다른 모듈을 import하지 않는다(§9.3).
// scripts/reset-admin-password.mjs 가 같은 형식을 Node crypto.webcrypto 로 다시 구현한다. 두 파일의 반복 수 상수는 테스트가 대조한다.

/** workerd 의 PBKDF2 상한. 넘기면 workerd 에서 'Pbkdf2 failed' 가 나지만 Node 하니스는 통과하므로 테스트로 고정한다. */
export const PBKDF2_ITERATIONS = 100_000;
export const PBKDF2_HASH = "SHA-256";
export const PBKDF2_SALT_BYTES = 16;
export const PBKDF2_KEY_BYTES = 32;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;
export const TEMP_PASSWORD_LENGTH = 12;
/** 헷갈리는 글자(I, O, l, o, 0, 1)를 뺀 56자. */
export const TEMP_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const HASH_SCHEME = "pbkdf2_sha256";

export const PASSWORD_POLICY_MESSAGE = `비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상 ${PASSWORD_MAX_LENGTH}자 이하로 입력해 주세요.`;

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

async function derive(password: string, salt: Uint8Array, iterations: number, keyBytes: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: PBKDF2_HASH, salt, iterations }, key, keyBytes * 8);
  return new Uint8Array(bits);
}

/** 길이가 같으면 모든 바이트를 끝까지 비교한다. Node 에는 subtle.timingSafeEqual 이 없어 손으로 쓴다. */
export function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

/** 'pbkdf2_sha256$100000$<salt b64url>$<hash b64url>' */
export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_BYTES);
  return `${HASH_SCHEME}$${PBKDF2_ITERATIONS}$${base64UrlEncode(salt)}$${base64UrlEncode(hash)}`;
}

/** 형식이 틀리거나 반복 수가 1..100000 밖이면 false 다(workerd 상한을 넘는 해시로 서버를 멈추게 하지 못하게). */
export async function verifyPassword(password: string, stored: string) {
  const parts = typeof stored === "string" ? stored.split("$") : [];
  if (parts.length !== 4 || parts[0] !== HASH_SCHEME || !/^\d{1,6}$/.test(parts[1])) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const salt = base64UrlDecode(parts[2]);
  const expected = base64UrlDecode(parts[3]);
  if (!salt || !expected || salt.length === 0 || expected.length === 0 || expected.length > 64) return false;
  const actual = await derive(password, salt, iterations, expected.length);
  return constantTimeEqual(actual, expected);
}

/** 정책 위반이면 사용자에게 보여 줄 문구, 통과하면 null. */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) return PASSWORD_POLICY_MESSAGE;
  return null;
}

/** 12자 임시 비밀번호. 거부 표본추출로 글자마다 치우침이 없게 뽑는다. */
export function generateTemporaryPassword() {
  const limit = Math.floor(256 / TEMP_PASSWORD_ALPHABET.length) * TEMP_PASSWORD_ALPHABET.length;
  let result = "";
  while (result.length < TEMP_PASSWORD_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte >= limit) continue;
      result += TEMP_PASSWORD_ALPHABET[byte % TEMP_PASSWORD_ALPHABET.length];
      if (result.length === TEMP_PASSWORD_LENGTH) break;
    }
  }
  return result;
}

let dummyHash: Promise<string> | null = null;
/** 없는 이메일·비활성 계정에도 같은 비용의 검증을 하기 위한 해시. 처음 쓸 때 한 번만 계산한다. */
export function getDummyHash() {
  if (!dummyHash) {
    dummyHash = hashPassword(base64UrlEncode(crypto.getRandomValues(new Uint8Array(24))));
    dummyHash.catch(() => { dummyHash = null; });
  }
  return dummyHash;
}
