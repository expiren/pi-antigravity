import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	activateAccount,
	getAccountApiKey,
	loadAccountStore,
	removeAccount,
	updateRememberedAccount,
} from "../src/auth/accounts.js";
import { loadAntigravitySettings } from "../src/settings.js";
import { loadDisabledTools, setAntigravityToolEnabled } from "../src/tools/index.js";

const previousDir = process.env.PI_CODING_AGENT_DIR;
const root = mkdtempSync(join(tmpdir(), "pi-antigravity-v3-settings-"));
process.env.PI_CODING_AGENT_DIR = root;

const legacyPath = join(root, "antigravity-accounts.json");
const settingsPath = join(root, "pi-antigravity.json");
const healthPath = join(root, "antigravity-account-health.json");
const accounts = Object.fromEntries(
	Array.from({ length: 302 }, (_, index) => {
		const accountId = `simulated-${index}`;
		return [
			accountId,
			{
				accountId,
				email: `${accountId}@example.test`,
				access: `fake-access-${index}`,
				refresh: `fake-refresh-${index}`,
				expires: Date.now() + 86_400_000,
				projectId: "synthetic-project",
				addedAt: index + 1,
				lastUsedAt: index + 2,
			},
		];
	}),
);
const health = {
	version: 1,
	updatedAt: 1,
	sequence: 8,
	records: {
		"synthetic-record": {
			accountId: "simulated-0",
			projectId: "synthetic-project",
			model: "synthetic-model",
			status: "hard_quota",
			cooldownUntil: 9_000_000_000_000,
		},
	},
	reservations: {
		"synthetic-reservation": {
			accountId: "simulated-1",
			projectId: "synthetic-project",
			model: "synthetic-model",
			until: 9_000_000_000_000,
		},
	},
};

try {
	writeFileSync(legacyPath, JSON.stringify({ version: 1, activeAccountId: "simulated-0", accounts }));
	writeFileSync(healthPath, JSON.stringify(health));
	const originalLegacy = readFileSync(legacyPath);
	const originalHealth = readFileSync(healthPath);

	const loaded = loadAccountStore(true);
	assert.equal(Object.keys(loaded.accounts).length, 302);
	assert.equal(loaded.activeAccountId, "simulated-0");
	assert.equal(loaded.accounts["simulated-0"]?.addedAt, 1);
	assert.equal(loadDisabledTools().size, 0);
	assert.equal(existsSync(settingsPath), false, "read-only reporting must not migrate credentials");
	assert.deepEqual(readFileSync(legacyPath), originalLegacy);
	assert.deepEqual(readFileSync(healthPath), originalHealth);

	setAntigravityToolEnabled("web_search", false);
	const settings = loadAntigravitySettings();
	assert.equal(settings.legacyAccountsMigrated, true);
	assert.equal(Object.keys(loadAccountStore(true).accounts).length, 302);
	assert.equal(loadDisabledTools().has("web_search"), true);
	assert.equal((await getAccountApiKey("simulated-0")).token, "fake-access-0");

	updateRememberedAccount(accounts["simulated-0"], {
		...accounts["simulated-0"],
		refresh: "rotated-fake-refresh",
	});
	assert.equal(loadAccountStore(true).accounts["simulated-0"]?.refresh, "rotated-fake-refresh");
	assert.equal(loadAccountStore(true).accounts["simulated-0"]?.addedAt, 1);
	assert.equal(loadAccountStore(true).activeAccountId, "simulated-0");

	await activateAccount("simulated-2");
	assert.equal(loadAccountStore(true).activeAccountId, "simulated-2");
	assert.equal(Object.keys(loadAccountStore(true).accounts).length, 302);
	assert.equal(loadDisabledTools().has("web_search"), true);
	assert.deepEqual(readFileSync(legacyPath), originalLegacy);
	assert.deepEqual(readFileSync(healthPath), originalHealth);

	await removeAccount("simulated-301");
	assert.equal(Object.keys(loadAccountStore(true).accounts).length, 301);
	assert.equal(loadAccountStore(true).accounts["simulated-301"], undefined);
	assert.deepEqual(readFileSync(legacyPath), originalLegacy);
	assert.deepEqual(readFileSync(healthPath), originalHealth);

	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(root, "partial-"));
	const partialLegacyPath = join(process.env.PI_CODING_AGENT_DIR, "antigravity-accounts.json");
	const partialSettingsPath = join(process.env.PI_CODING_AGENT_DIR, "pi-antigravity.json");
	writeFileSync(
		partialLegacyPath,
		JSON.stringify({
			version: 1,
			activeAccountId: "simulated-0",
			accounts: { "simulated-0": accounts["simulated-0"], "simulated-1": accounts["simulated-1"] },
		}),
	);
	writeFileSync(
		partialSettingsPath,
		JSON.stringify({
			version: 1,
			activeAccountId: "newer",
			disabledTools: ["url_context"],
			accounts: {
				"simulated-0": { ...accounts["simulated-0"], refresh: "newer-fake-refresh" },
				newer: { ...accounts["simulated-2"], accountId: "newer" },
			},
			futureOption: true,
		}),
	);
	const partialLegacyBytes = readFileSync(partialLegacyPath);
	const partialSettingsBytes = readFileSync(partialSettingsPath);
	const combined = loadAccountStore(true);
	assert.equal(Object.keys(combined.accounts).length, 3);
	assert.equal(combined.accounts["simulated-0"]?.refresh, "newer-fake-refresh");
	assert.equal(combined.activeAccountId, "newer");
	assert.deepEqual(readFileSync(partialSettingsPath), partialSettingsBytes);
	setAntigravityToolEnabled("web_search", false);
	assert.equal(Object.keys(loadAccountStore(true).accounts).length, 3);
	assert.equal(loadAntigravitySettings().futureOption, true);
	assert.deepEqual([...loadDisabledTools()], ["url_context", "web_search"]);
	assert.deepEqual(readFileSync(partialLegacyPath), partialLegacyBytes);

	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(root, "invalid-"));
	const invalidLegacy = join(process.env.PI_CODING_AGENT_DIR, "antigravity-accounts.json");
	const invalidSettings = join(process.env.PI_CODING_AGENT_DIR, "pi-antigravity.json");
	writeFileSync(invalidLegacy, '{"version":1,"accounts":{"bad":{"refresh":""}}}');
	writeFileSync(invalidSettings, '{"version":1,"disabledTools":["web_search"]}');
	const originalSettings = readFileSync(invalidSettings);
	assert.throws(() => loadAccountStore(true), /invalid Antigravity accounts/);
	assert.deepEqual(readFileSync(invalidSettings), originalSettings);
	assert.equal(existsSync(invalidLegacy), true);

	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(root, "invalid-settings-"));
	const validLegacyPath = join(process.env.PI_CODING_AGENT_DIR, "antigravity-accounts.json");
	const corruptSettingsPath = join(process.env.PI_CODING_AGENT_DIR, "pi-antigravity.json");
	writeFileSync(
		validLegacyPath,
		JSON.stringify({ version: 1, accounts: { "simulated-0": accounts["simulated-0"] } }),
	);
	writeFileSync(corruptSettingsPath, "{broken");
	const validLegacyBytes = readFileSync(validLegacyPath);
	assert.throws(() => setAntigravityToolEnabled("web_search", false), /unreadable or unsupported settings/);
	assert.deepEqual(readFileSync(validLegacyPath), validLegacyBytes);
	assert.equal(readFileSync(corruptSettingsPath, "utf8"), "{broken");

	console.log("V3 settings compatibility tests: ok");
} finally {
	if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousDir;
	rmSync(root, { recursive: true, force: true });
}
