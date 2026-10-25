import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";

const SETTINGS_FILE = "pi-antigravity.json";
const LEGACY_ACCOUNTS_FILE = "antigravity-accounts.json";

type Settings = Record<string, unknown>;

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || getAgentDir();
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function readSettings(path: string): Settings {
	if (!existsSync(path)) return {};
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (
			isObject(value) &&
			value.version === 1 &&
			(value.accounts === undefined || isObject(value.accounts))
		) {
			return value;
		}
	} catch {
		// Never include file contents: settings contain OAuth credentials.
	}
	throw new Error(`Refusing to overwrite unreadable or unsupported settings: ${path}`);
}

function writeSettings(path: string, settings: Settings): void {
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		chmodSync(tempPath, 0o600);
		renameSync(tempPath, path);
	} finally {
		if (existsSync(tempPath)) unlinkSync(tempPath);
	}
}

/** One private store for account credentials and tool preferences. */
export function loadAntigravitySettings(): Settings {
	const path = join(agentDir(), SETTINGS_FILE);
	const settings = readSettings(path);
	const legacyPath = join(agentDir(), LEGACY_ACCOUNTS_FILE);
	if (!existsSync(legacyPath) || settings.legacyAccountsMigrated === true) return settings;

	const legacy = readSettings(legacyPath);
	if (
		!isObject(legacy.accounts) ||
		Object.values(legacy.accounts).some(
			(account) => !isObject(account) || typeof account.refresh !== "string" || !account.refresh,
		)
	) {
		throw new Error("Refusing to migrate invalid Antigravity accounts");
	}
	const merged = {
		...legacy,
		...settings,
		version: 1,
		legacyAccountsMigrated: true,
		accounts: { ...legacy.accounts, ...(isObject(settings.accounts) ? settings.accounts : {}) },
	};
	// Reads leave the V3 store untouched; explicit updates commit the unified copy.
	return merged;
}

/** Re-read before patching so account and tool writes preserve each other's fields. */
export function updateAntigravitySettings(patch: Settings): void {
	const settings = loadAntigravitySettings();
	writeSettings(join(agentDir(), SETTINGS_FILE), { ...settings, ...patch, version: 1 });
}
