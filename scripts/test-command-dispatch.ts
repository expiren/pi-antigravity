import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	parseAntigravitySubcommand,
	registerAntigravityCommands,
} from "../src/commands/antigravity.js";
import { setHealthSelection, setLastError } from "../src/diagnostics/index.js";
import {
	ANTIGRAVITY_TOOLS,
	getAntigravityToolStates,
	isAntigravityToolEnabled,
	setAllAntigravityToolsEnabled,
	setAntigravityToolEnabled,
	syncAntigravityToolsWithSession,
	toggleAntigravityTool,
} from "../src/tools/index.js";
import {
	AntigravityDashboardComponent,
	buildDoctorSnapshot,
	formatDoctorTab,
	formatDoctorReport,
	formatModelsTab,
	formatToolsTab,
} from "../src/ui/dashboard.js";

console.log("Running antigravity command dispatch & multi-tab TUI tests...");

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-antigravity-cmd-"));

// Root command: no arguments opens the interactive control center.
expect(parseAntigravitySubcommand("")).toEqual({ action: "dashboard" });
expect(parseAntigravitySubcommand("   ")).toEqual({ action: "dashboard" });

// models
expect(parseAntigravitySubcommand("models")).toEqual({ action: "models", all: false });
expect(parseAntigravitySubcommand("  MODELS  ")).toEqual({ action: "models", all: false });
expect(parseAntigravitySubcommand("models all")).toEqual({ action: "models", all: true });
expect(parseAntigravitySubcommand("models ALL")).toEqual({ action: "models", all: true });
expect(parseAntigravitySubcommand("models  all ")).toEqual({ action: "models", all: true });

// tools
expect(parseAntigravitySubcommand("tools")).toEqual({ action: "tools" });
expect(parseAntigravitySubcommand("  TOOLS ")).toEqual({ action: "tools" });

// doctor
expect(parseAntigravitySubcommand("doctor")).toEqual({ action: "doctor" });
expect(parseAntigravitySubcommand("Doctor")).toEqual({ action: "doctor" });
expect(parseAntigravitySubcommand("health")).toEqual({ action: "health", model: undefined });
expect(parseAntigravitySubcommand("health gemini-3.8-flash")).toEqual({
	action: "health",
	model: "gemini-3.8-flash",
});

// Pruned flags from the pre-convergence command surface.
for (const args of ["current", "2", "remove a@example.com", "refresh", "image", "search"]) {
	const parsed = parseAntigravitySubcommand(args);
	expect(parsed.action).toBe("invalid");
	if (parsed.action === "invalid") {
		expect(parsed.message.length).toBeGreaterThan(0);
	}
}

const registered = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
registerAntigravityCommands({
	registerCommand(name, command) {
		expect(registered.has(name)).toBe(false);
		registered.set(name, command);
	},
} as ExtensionAPI);
expect([...registered.keys()]).toEqual(["antigravity", "antigravity.usage"]);
const originalLog = console.log;
let commandOutput = "";
try {
	console.log = (...args: unknown[]) => {
		commandOutput += args.join(" ");
	};
	await registered.get("antigravity")!.handler("health gemini-3.8-flash", {
		hasUI: false,
	} as ExtensionCommandContext);
} finally {
	console.log = originalLog;
}
expect(commandOutput).toContain("model=gemini-3.8-flash");
expect(commandOutput).toContain("linked=0");

setLastError("Failure for test@example.com");
setHealthSelection({
	selectedAccount: "simulated-0",
	runtimeModel: "gemini-3.8-flash",
	rotationCount: 1,
	skipReasons: {},
	basis: "unknown",
});
const doctorSnapshot = buildDoctorSnapshot();
expect(doctorSnapshot.error).not.toContain("test@example.com");
expect(doctorSnapshot.selectedAccount).toBe("[redacted-account]");
expect(formatDoctorReport(doctorSnapshot)).toContain("linked=0");
expect(formatDoctorTab(doctorSnapshot)).toContain("linked=0");
setLastError(undefined);
setHealthSelection({
	selectedAccount: "none",
	runtimeModel: "unknown",
	rotationCount: 0,
	skipReasons: {},
	basis: "unknown",
});

// Tool management & session sync tests
expect(getAntigravityToolStates().length).toBe(ANTIGRAVITY_TOOLS.length);
expect(getAntigravityToolStates().every((t) => t.enabled)).toBe(true);

let activeSessionTools = ["read", "bash", "web_search", "url_context", "generate_image", "analyze_file"];
const mockPi = {
	getActiveTools: () => [...activeSessionTools],
	setActiveTools: (names: string[]) => {
		activeSessionTools = [...names];
	},
};

expect(setAntigravityToolEnabled("generate_image", false, mockPi)).toBe(false);
expect(isAntigravityToolEnabled("generate_image")).toBe(false);
expect(activeSessionTools.includes("generate_image")).toBe(false);
expect(activeSessionTools.includes("web_search")).toBe(true);

expect(toggleAntigravityTool("generate_image", mockPi)).toBe(true);
expect(isAntigravityToolEnabled("generate_image")).toBe(true);
expect(activeSessionTools.includes("generate_image")).toBe(true);

setAllAntigravityToolsEnabled(false, mockPi);
expect(getAntigravityToolStates().every((t) => !t.enabled)).toBe(true);
expect(activeSessionTools).toEqual(["read", "bash"]);

// Simulate session_start ensuring disabled tools remain excluded
activeSessionTools = ["read", "bash", "web_search"];
syncAntigravityToolsWithSession(mockPi);
expect(activeSessionTools).toEqual(["read", "bash"]);

setAllAntigravityToolsEnabled(true, mockPi);
expect(getAntigravityToolStates().every((t) => t.enabled)).toBe(true);
expect(activeSessionTools).toContain("web_search");
expect(activeSessionTools).toContain("analyze_file");

// Multi-tab TUI component tests
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const mockKb = {
	matches: (data: string, action: string) => {
		if (action === "tui.select.cancel") return data === "\x1b";
		if (action === "tui.select.up") return data === "\x1b[A";
		if (action === "tui.select.down") return data === "\x1b[B";
		if (action === "tui.select.confirm") return data === "\r";
		return false;
	},
} as unknown as KeybindingsManager;

let refreshModelsCalls = 0;
let toggledToolName: string | undefined;

const sampleRows = [
	{
		index: 1,
		accountId: "a@example.com",
		shortLabel: "look",
		active: true,
		loading: false,
		usage: {
			endpoint: "synthetic-endpoint",
			projectId: "proj-1",
			models: [
				{
					modelId: "gemini-3.8-flash",
					remainingFraction: 0.85,
					supportsThinking: true,
					supportsImages: true,
					recommended: true,
				},
				{
					modelId: "tab_internal_model",
					remainingFraction: 1.0,
				},
			],
			groups: [],
			fetchedAt: Date.now(),
		},
	},
];

const component = new AntigravityDashboardComponent(
	sampleRows,
	0,
	plainTheme,
	mockKb,
	() => { },
	{
		actions: {
			onRefreshModels: () => {
				refreshModelsCalls++;
			},
			onToggleTool: (name) => {
				toggledToolName = name;
			},
		},
	},
);

// Default tab is accounts
expect(component.getTab()).toBe("accounts");
const accountsRender = component.render(100).join("\n");
expect(accountsRender).toContain("[1 账号]");
expect(accountsRender).toContain("2 模型");
expect(accountsRender).toContain("3 工具");
expect(accountsRender).toContain("4 诊断");
expect(accountsRender).toContain("look");

// Press Tab -> switches to models tab
component.handleInput("\t");
expect(component.getTab()).toBe("models");
const modelsRender = component.render(100).join("\n");
expect(modelsRender).toContain("[2 模型]");
expect(modelsRender).toContain("gemini-3.8-flash");
expect(modelsRender).not.toContain("tab_internal_model");

// Press 'a' in models tab -> shows all models including internal tab_ models
component.handleInput("a");
expect(component.render(100).join("\n")).toContain("tab_internal_model");

// Press 'r' in models tab -> triggers model catalog refresh
component.handleInput("r");
expect(refreshModelsCalls).toBe(1);

// Press '3' -> jumps to tools tab
component.handleInput("3");
expect(component.getTab()).toBe("tools");
const toolsRender = component.render(100).join("\n");
expect(toolsRender).toContain("[3 工具]");
expect(toolsRender).toContain("web_search");
expect(toolsRender).toContain("analyze_file");

// Press Space in tools tab -> toggles first tool (web_search)
component.handleInput(" ");
expect(toggledToolName).toBe("web_search");

// Press '4' -> jumps to doctor tab
component.handleInput("4");
expect(component.getTab()).toBe("doctor");
const doctorRender = component.render(100).join("\n");
expect(doctorRender).toContain("[4 诊断]");
expect(doctorRender).toContain("Provider");
expect(doctorRender).toContain("antigravity");

// Formatters standalone checks
expect(formatModelsTab(sampleRows[0], { showAll: false })).toContain("gemini-3.8-flash");
expect(formatToolsTab(getAntigravityToolStates())).toContain("web_search");
expect(
	formatDoctorTab({
		provider: "antigravity",
		activeAccountLabel: "l***k@gmail.com",
		linkedAccountsCount: 1,
		enabledTools: ["web_search"],
		totalToolsCount: 4,
		resolvedRuntimeModel: "gemini-3.8-flash-tiered",
		matchedModelDebug: "exact",
		availableModels: "gemini-3.8-flash",
		endpoint: "https://cloudcode-pa.googleapis.com",
		status: 200,
		latencyMs: 120,
		projectId: "proj-1",
		toolSchemaWarnings: "none",
		error: "none",
	}),
).toContain("200 (120ms)");

console.log("antigravity command dispatch & multi-tab TUI tests passed");
