import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CREDENTIALS_FILE_NAME, CredentialsStore, parseCredentials, serializeCredentials, unreadableFileName, type StoredCredentials } from "../src/main/credentials.ts";
import { describeAccess, ownerOnlyIcaclsArgs, parseWhoamiSid } from "../src/main/owner-only.ts";

const HOST_ID = "urn:uuid:5b6f0f8e-2d7a-4c1e-9b3a-7e2f4d6c8a10";
const SIGNED_IN = {
  issuer: "https://auth.openai.com",
  clientId: "oaiapp_test",
  subject: "sub-1",
  email: "clinician@example.invalid",
  name: "Test Clinician",
  idToken: "id-token",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  tokenType: "Bearer",
  expiresAt: "2026-11-22T19:00:00.000Z",
  earliestRefreshAt: null,
  scopes: ["openid", "chatgpt.tokens.use.direct"],
  savedAt: "2026-11-22T18:00:00.000Z",
};

async function folder(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "aba-credentials-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const quiet = { log: () => undefined, restrict: async () => undefined };
const bytes = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

test("credentials file: version 1 reads back as written, unknown keys kept", () => {
  const credentials: StoredCredentials = { hostId: HOST_ID, claude: { apiKey: "sk-ant-x", savedAt: "2026-11-22T18:00:00.000Z" }, chatgpt: SIGNED_IN as never, later: { kept: true } };
  const text = serializeCredentials(credentials);
  assert.ok(text.startsWith('{\n  "version": 1,\n  "hostId"'), text);
  assert.deepEqual(parseCredentials(bytes(text)), { ok: true, credentials });
  const signedOut = { version: 1, hostId: HOST_ID, claude: null, chatgpt: { issuer: "https://auth.openai.com", clientId: "oaiapp_test", subject: "sub-1", signedOut: true } };
  assert.equal(parseCredentials(bytes(signedOut)).ok, true);
});

test("credentials file: damaged and newer files are recognized, never guessed at", () => {
  const good = { version: 1, hostId: HOST_ID, claude: null, chatgpt: null };
  const damaged: unknown[] = [
    "not json",
    "[]",
    { ...good, version: 0 },
    { ...good, version: "1" },
    { ...good, hostId: "laptop-1" },
    { ...good, hostId: "urn:uuid:5B6F0F8E-2D7A-4C1E-9B3A-7E2F4D6C8A10" },
    { ...good, claude: { apiKey: "" , savedAt: "2026-11-22T18:00:00.000Z" } },
    { ...good, chatgpt: { ...SIGNED_IN, issuer: "https://attacker.invalid" } },
    { ...good, chatgpt: { ...SIGNED_IN, tokenType: "mac" } },
    { ...good, chatgpt: { ...SIGNED_IN, accessToken: undefined } },
    '{"version":1,"version":1,"hostId":"' + HOST_ID + '","claude":null,"chatgpt":null}',
    '{"__proto__":{},"version":1,"hostId":"' + HOST_ID + '","claude":null,"chatgpt":null}',
  ];
  for (const value of damaged) assert.deepEqual(parseCredentials(bytes(value)), { ok: false, problem: "damaged" }, JSON.stringify(value));
  assert.deepEqual(parseCredentials(new Uint8Array([0x7b, 0xff, 0x7d])), { ok: false, problem: "damaged" }, "not UTF-8");
  assert.deepEqual(parseCredentials(bytes({ ...good, version: 2 })), { ok: false, problem: "newer-version" });
});

test("credentials store: no file is no credentials; the first save makes a host id and the file, owner-only", async (t) => {
  const dir = await folder(t);
  const file = path.join(dir, CREDENTIALS_FILE_NAME);
  const restricted: string[] = [];
  const store = new CredentialsStore(file, { log: () => undefined, restrict: async (target) => void restricted.push(target) });
  assert.deepEqual(await store.read(), { ok: true, credentials: null });
  const hostId = await store.hostId();
  assert.match(hostId, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(await store.hostId(), hostId, "never changes");
  await store.update((c) => ({ ...c, claude: { apiKey: "sk-ant-test", savedAt: "2026-11-22T18:00:00.000Z" } }));
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  assert.equal(onDisk.hostId, hostId, "the host id survives later saves");
  assert.equal(onDisk.claude.apiKey, "sk-ant-test");
  assert.equal(restricted.length, 2, "owner-only access is set on every temporary file before it is written");
  assert.ok(restricted.every((target) => /credentials\.json\.\d+\.tmp$/.test(target)));
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dir)).sort(), [CREDENTIALS_FILE_NAME], "no temporary file left");
  // A new store (a restart) reads what was saved.
  const again = new CredentialsStore(file, quiet);
  const read = await again.read();
  assert.ok(read.ok && read.credentials);
  assert.equal(read.credentials.claude?.apiKey, "sk-ant-test");
});

test("credentials store: a damaged, newer or linked file shows the problem and is never written", async (t) => {
  const dir = await folder(t);
  const cases: Array<[string, (file: string) => Promise<void>, string]> = [
    ["damaged", (file) => writeFile(file, "{ half a file"), "damaged"],
    ["newer", (file) => writeFile(file, JSON.stringify({ version: 9, hostId: HOST_ID, claude: null, chatgpt: null })), "newer-version"],
    ["folder", (file) => mkdir(file), "damaged"],
  ];
  if (process.platform !== "win32") cases.push(["link", (file) => symlink(path.join(dir, "elsewhere.json"), file), "damaged"]);
  for (const [name, make, problem] of cases) {
    const sub = path.join(dir, name);
    await mkdir(sub);
    const file = path.join(sub, CREDENTIALS_FILE_NAME);
    await make(file);
    const before = await readdir(sub);
    const store = new CredentialsStore(file, quiet);
    assert.deepEqual(await store.read(), { ok: false, problem }, name);
    await assert.rejects(store.update((c) => c), /^Error: Refused: the credentials file cannot be used/, name);
    await assert.rejects(store.hostId(), /Refused/, name);
    assert.deepEqual(await readdir(sub), before, `${name}: nothing written`);
  }
});

test("credentials store: Start over renames the file aside, never deletes it, then starts empty", async (t) => {
  const dir = await folder(t);
  const file = path.join(dir, CREDENTIALS_FILE_NAME);
  await writeFile(file, "{ damaged", { mode: 0o600 });
  const store = new CredentialsStore(file, quiet);
  const now = new Date("2026-11-22T18:05:48.123Z");
  assert.equal(await store.startOver(now), true);
  const aside = path.join(dir, "credentials.json.unreadable-2026-11-22T18-05-48Z");
  assert.equal(await readFile(aside, "utf8"), "{ damaged", "kept as it was");
  if (process.platform !== "win32") assert.equal((await stat(aside)).mode & 0o777, 0o600, "still owner-only");
  assert.deepEqual(await store.read(), { ok: true, credentials: null });
  assert.equal(await store.startOver(now), false, "a usable file is never set aside");
  // A second unreadable file in the same second gets its own name.
  await writeFile(file, "{ again");
  const second = new CredentialsStore(file, quiet);
  assert.equal(await second.startOver(now), true);
  assert.equal(await readFile(path.join(dir, unreadableFileName(now, 1)), "utf8"), "{ again");
});

test("credentials store: Start over makes the set-aside file owner-only, and a damaged file others can read is made owner-only when read", { skip: process.platform === "win32" }, async (t) => {
  const dir = await folder(t);
  const file = path.join(dir, CREDENTIALS_FILE_NAME);
  await writeFile(file, '{ "claude": { "apiKey": "sk-ant-in-a-damaged-file"', { mode: 0o644 });
  await chmod(file, 0o644);
  const store = new CredentialsStore(file, quiet);
  assert.deepEqual(await store.read(), { ok: false, problem: "damaged" });
  assert.equal((await stat(file)).mode & 0o777, 0o600, "made owner-only although it cannot be read");
  await chmod(file, 0o644);
  const now = new Date("2026-11-22T18:00:00.000Z");
  assert.equal(await store.startOver(now), true);
  assert.equal((await stat(path.join(dir, unreadableFileName(now)))).mode & 0o777, 0o600);
});

test("credentials store: a file others can read is made owner-only again (macOS and Linux)", { skip: process.platform === "win32" }, async (t) => {
  const dir = await folder(t);
  const file = path.join(dir, CREDENTIALS_FILE_NAME);
  await writeFile(file, JSON.stringify({ version: 1, hostId: HOST_ID, claude: null, chatgpt: null }));
  await chmod(file, 0o644);
  const store = new CredentialsStore(file, quiet);
  assert.equal((await store.read()).ok, true);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("credentials store: a save that cannot be written throws and leaves the credentials as they were", async (t) => {
  const dir = await folder(t);
  const file = path.join(dir, CREDENTIALS_FILE_NAME);
  const store = new CredentialsStore(file, { log: () => undefined, restrict: async () => Promise.reject(new Error("icacls failed")) });
  await assert.rejects(store.update((c) => ({ ...c, claude: { apiKey: "sk-ant-x", savedAt: "2026-11-22T18:00:00.000Z" } })), /icacls failed/);
  assert.deepEqual(await store.read(), { ok: true, credentials: null });
  assert.deepEqual(await readdir(dir), [], "no file and no temporary file: a secret is never written without owner-only access");
});

test("credentials store: leftover temporary files of a crashed save are removed at start", async (t) => {
  const dir = await folder(t);
  const file = path.join(dir, CREDENTIALS_FILE_NAME);
  await writeFile(`${file}.12345.tmp`, "partial secrets");
  await new CredentialsStore(file, quiet).read();
  assert.deepEqual(await readdir(dir), []);
});

test("Windows owner-only: whoami's SID and the icacls arguments", () => {
  assert.equal(parseWhoamiSid('"desktop-1\\ana","S-1-5-21-1004336348-1177238915-682003330-1001"\r\n'), "S-1-5-21-1004336348-1177238915-682003330-1001");
  assert.equal(parseWhoamiSid("nothing useful"), null);
  assert.deepEqual(ownerOnlyIcaclsArgs("C:\\x\\credentials.json.1.tmp", "S-1-5-21-1-2-3-1001"), ["C:\\x\\credentials.json.1.tmp", "/inheritance:r", "/grant:r", "*S-1-5-21-1-2-3-1001:(F)"]);
});

test("Windows owner-only: the saved file has one access entry, the current user's, nothing inherited", { skip: process.platform !== "win32" }, async (t) => {
  const dir = await folder(t);
  const file = path.join(dir, CREDENTIALS_FILE_NAME);
  const store = new CredentialsStore(file, { log: () => undefined });
  await store.hostId();
  const access = await describeAccess(file);
  const entries = access.split(/\r?\n/).filter((line) => /:\([A-Z,()]+\)\s*$/.test(line.trim()) || /:\(F\)/.test(line));
  assert.equal(entries.length, 1, access);
  assert.doesNotMatch(access, /\(I\)/, "no inherited entry");
});
