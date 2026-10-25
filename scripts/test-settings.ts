import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAccountStore, rememberAccount, updateRememberedAccount } from "../src/auth/accounts.js";
import { loadAntigravitySettings } from "../src/settings.js";
import { loadDisabledTools, setAntigravityToolEnabled } from "../src/tools/index.js";

const previousDir = process.env.PI_CODING_AGENT_DIR;
const root = mkdtempSync(join(tmpdir(), "pi-antigravity-settings-"));
const settingsPath = () => join(process.env.PI_CODING_AGENT_DIR!, "pi-antigravity.json");
const legacyPath = () => join(process.env.PI_CODING_AGENT_DIR!, "antigravity-accounts.json");
const credentials = {
	email: "test@example.com",
	access: "test-access",
	refresh: "test-refresh",
	expires: Date.now() + 3_600_000,
	projectId: "test-project",
};
const stored = { ...credentials, accountId: credentials.email, addedAt: 1, lastUsedAt: 2 };
const legacy = {
	version: 1,
	activeAccountId: stored.accountId,
	accounts: { [stored.accountId]: stored },
};

function fixture(name: string): void {
	process.env.PI_CODING_AGENT_DIR = join(root, name);
}

function put(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value));
}

try {
	fixture("new/nested");
	assert.deepEqual(loadAntigravitySettings(), {});
	assert.deepEqual(loadAccountStore().accounts, {});
	assert.equal(existsSync(settingsPath()), false);
	setAntigravityToolEnabled("web_search", false);
	rememberAccount(credentials);
	assert.equal(loadDisabledTools().has("web_search"), true);
	assert.equal(loadAccountStore().activeAccountId, credentials.email);
	setAntigravityToolEnabled("generate_image", false);
	assert.equal(loadAccountStore().accounts[credentials.email].refresh, credentials.refresh);
	updateRememberedAccount(credentials, { ...credentials, refresh: "rotated-refresh" });
	assert.deepEqual([...loadDisabledTools()], ["web_search", "generate_image"]);
	assert.equal(loadAccountStore().accounts[credentials.email].refresh, "rotated-refresh");
	assert.equal(existsSync(legacyPath()), false);
	assert.equal(statSync(settingsPath()).mode & 0o777, 0o600);

	// A tool write also tightens permissions on an existing public settings file.
	chmodSync(settingsPath(), 0o644);
	setAntigravityToolEnabled("web_search", true);
	assert.equal(statSync(settingsPath()).mode & 0o777, 0o600);

	for (const withSettings of [false, true]) {
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(root, "migration-"));
		put(legacyPath(), legacy);
		const legacyBytes = readFileSync(legacyPath(), "utf8");
		if (withSettings) put(settingsPath(), { version: 1, disabledTools: ["url_context"] });
		const settingsBytes = withSettings ? readFileSync(settingsPath(), "utf8") : undefined;
		assert.equal(loadAccountStore().accounts[stored.accountId].refresh, stored.refresh);
		assert.equal(loadAccountStore().activeAccountId, stored.accountId);
		assert.equal(loadDisabledTools().has("url_context"), withSettings);
		assert.equal(readFileSync(legacyPath(), "utf8"), legacyBytes);
		assert.equal(existsSync(settingsPath()), withSettings);
		if (settingsBytes) assert.equal(readFileSync(settingsPath(), "utf8"), settingsBytes);
		setAntigravityToolEnabled("web_search", false);
		assert.equal(statSync(settingsPath()).mode & 0o777, 0o600);
		assert.equal(existsSync(join(process.env.PI_CODING_AGENT_DIR!, "auth.json")), false);
		assert.deepEqual(loadAntigravitySettings(), JSON.parse(readFileSync(settingsPath(), "utf8")));
		assert.equal(readFileSync(legacyPath(), "utf8"), legacyBytes);
	}

	// A partially completed migration must not replace newer tokens or drop either account.
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(root, "resume-"));
	put(legacyPath(), legacy);
	put(settingsPath(), {
		version: 1,
		disabledTools: ["analyze_file"],
		activeAccountId: "other",
		accounts: {
			[stored.accountId]: { ...stored, refresh: "newer-refresh" },
			other: { ...stored, accountId: "other" },
		},
		futureOption: true,
	});
	assert.equal(loadAccountStore().accounts[stored.accountId].refresh, "newer-refresh");
	assert.equal(loadAccountStore().activeAccountId, "other");
	assert.deepEqual([...loadDisabledTools()], ["analyze_file"]);
	assert.equal(existsSync(legacyPath()), true);
	setAntigravityToolEnabled("web_search", false);
	rememberAccount(credentials);
	assert.equal(loadAntigravitySettings().futureOption, true);
	assert.equal(Object.keys(loadAccountStore().accounts).length, 2);

	// Invalid files must remain untouched, including the migration source.
	for (const invalid of [
		"{broken",
		"[]",
		'{"version":2}',
		'{"version":1,"accounts":[]}',
		'{"version":1,"accounts":{"bad":{"refresh":""}}}',
	]) {
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(root, "invalid-legacy-"));
		writeFileSync(legacyPath(), invalid);
		put(settingsPath(), { version: 1, disabledTools: ["web_search"] });
		const before = readFileSync(settingsPath(), "utf8");
		assert.throws(() => setAntigravityToolEnabled("web_search", true));
		assert.equal(readFileSync(legacyPath(), "utf8"), invalid);
		assert.equal(readFileSync(settingsPath(), "utf8"), before);
	}
	for (const invalid of ["{broken", "[]", '{"version":2}']) {
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(root, "invalid-settings-"));
		put(legacyPath(), legacy);
		writeFileSync(settingsPath(), invalid);
		assert.throws(() => rememberAccount(credentials));
		assert.equal(readFileSync(settingsPath(), "utf8"), invalid);
		assert.deepEqual(JSON.parse(readFileSync(legacyPath(), "utf8")), legacy);
	}
	console.log("settings tests: ok");
} finally {
	if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousDir;
	rmSync(root, { recursive: true, force: true });
}
