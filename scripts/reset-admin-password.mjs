// 앱을 멈춘 상태에서 계정 하나의 비밀번호를 초기화한다(Design §11.5.6, §7.4 '복구 수단').
//
//   node scripts/reset-admin-password.mjs --email <계정 이메일> --state <.wrangler/state 폴더>
//
// 하는 일: 잠금 해제, 임시 비밀번호(12자) 발급과 콘솔 1회 표시, must_change_password=1, 그 계정 세션 전부 폐기,
// SYSTEM 감사 행 ACCOUNT_PASSWORD_RESET_OFFLINE. 한 트랜잭션으로 쓴다.
// 대상 --state 를 쓰는 서버가 떠 있으면 거부한다: 운영 pid 파일의 프로세스가 살아 있거나 127.0.0.1:3000 이 열려 있으면 거부하고,
// 운영 폴더(C:\xdm\prod)가 아니면 개발 dev 포트 127.0.0.1:3100 도 확인한다.
// 해시 형식은 app/auth-password.ts 와 같다. 반복 수 상수가 같은지는 테스트(tests/auth-session.test.mjs)가 대조한다.
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { findAppDatabase } from "./lib/d1-state.mjs";

export const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BYTES = 32;
const TEMP_PASSWORD_LENGTH = 12;
const TEMP_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const PID_FILE = "C:\\xdm\\run\\xdm-management.pid";
const PROD_ROOT = "c:\\xdm\\prod";

const base64Url = (bytes) => Buffer.from(bytes).toString("base64url");

export async function hashPassword(password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, PBKDF2_KEY_BYTES * 8);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${base64Url(salt)}$${base64Url(new Uint8Array(bits))}`;
}

export function generateTemporaryPassword() {
  const limit = Math.floor(256 / TEMP_PASSWORD_ALPHABET.length) * TEMP_PASSWORD_ALPHABET.length;
  let result = "";
  while (result.length < TEMP_PASSWORD_LENGTH) {
    for (const byte of webcrypto.getRandomValues(new Uint8Array(32))) {
      if (byte >= limit) continue;
      result += TEMP_PASSWORD_ALPHABET[byte % TEMP_PASSWORD_ALPHABET.length];
      if (result.length === TEMP_PASSWORD_LENGTH) break;
    }
  }
  return result;
}

/** 앱 DB 파일 하나에 초기화를 적용한다. 계정이 없으면 throw. */
export async function resetAccountPassword(dbFile, email, now = Date.now()) {
  const normalized = String(email ?? "").trim().toLowerCase();
  if (!normalized) throw new Error("--email 을 지정하세요.");
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const db = new DatabaseSync(dbFile);
  try {
    const account = db.prepare("SELECT id FROM auth_accounts WHERE email = ?").get(normalized);
    if (!account) throw new Error("해당 이메일의 계정이 없습니다.");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`UPDATE auth_accounts SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL, updated_at = ?
        WHERE id = ?`).run(passwordHash, now, account.id);
      const revoked = db.prepare(`UPDATE auth_sessions SET revoked_at = ?, revoked_reason = 'PASSWORD_RESET' WHERE account_id = ? AND revoked_at IS NULL`)
        .run(now, account.id);
      const revokedSessions = Number(revoked.changes);
      db.prepare(`INSERT INTO erp_audit_logs (id, actor_user_id, actor_email, actor_employee_id, module, action, entity_type, entity_id,
          before_json, after_json, reason, created_at)
        VALUES (?, 'SYSTEM', 'script:reset-admin-password', 'SYSTEM', 'admin', 'ACCOUNT_PASSWORD_RESET_OFFLINE', 'AUTH_ACCOUNT', ?, NULL, ?, '', ?)`)
        .run(webcrypto.randomUUID(), account.id, JSON.stringify({ temporaryPasswordIssued: true, revokedSessions }), now);
      db.exec("COMMIT");
      return { accountId: account.id, temporaryPassword, revokedSessions };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function portOpen(port) {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (open) => { socket.destroy(); done(open); };
    socket.setTimeout(800, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function pidAlive() {
  let pid;
  try {
    pid = Number(readFileSync(PID_FILE, "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** 서버가 떠 있다는 근거가 있으면 그 이유 문구, 없으면 null. */
export async function runningServerReason(stateDir) {
  if (pidAlive()) return `운영 pid 파일(${PID_FILE})의 프로세스가 살아 있습니다.`;
  if (await portOpen(3000)) return "127.0.0.1:3000 에서 서버가 응답합니다.";
  if (!resolve(stateDir).toLowerCase().startsWith(PROD_ROOT) && await portOpen(3100)) return "127.0.0.1:3100(개발 dev)에서 서버가 응답합니다.";
  return null;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const email = argValue(args, "--email");
  const stateDir = argValue(args, "--state");
  if (!email || !stateDir) {
    console.error("사용법: node scripts/reset-admin-password.mjs --email <계정 이메일> --state <.wrangler/state 폴더>");
    process.exit(2);
  }
  const running = await runningServerReason(stateDir);
  if (running) {
    console.error(`거부: ${running} 앱을 완전히 멈춘 뒤(taskkill /T) 다시 실행하세요.`);
    process.exit(1);
  }
  const result = await resetAccountPassword(findAppDatabase(stateDir), email);
  console.log(`계정 ${result.accountId} 의 비밀번호를 초기화했습니다. 폐기한 세션: ${result.revokedSessions}개.`);
  console.log(`임시 비밀번호(이번에만 표시): ${result.temporaryPassword}`);
  console.log("첫 로그인 때 비밀번호를 바꾸게 됩니다.");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`실패: ${error.message}`);
    process.exit(1);
  });
}
