import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getLastDiagnostics, runWithDiagnostics } from "../diagnostics/index.js";
import { formatHealthSummary, healthSummary } from "../health/report.js";
import { getAntigravityRequestModelId } from "../models/index.js";
import { getAntigravityToolStates } from "../tools/index.js";
import {
	fetchAccountModelsUsage,
	formatModelsList,
	resolveApiKeyFromContext,
} from "../usage/index.js";
import {
	buildDoctorSnapshot,
	emitCommandOutput,
	formatDoctorReport,
	formatToolsReport,
	refreshModelCatalog,
	runAccountsDashboard,
} from "../ui/index.js";
import { redactSecrets } from "../utils/index.js";

const ROOT_HELP = "Usage: /antigravity [models | tools | doctor | health [runtime-model]]";

export type AntigravitySubcommand =
	| { action: "dashboard" }
	| { action: "models"; all: boolean }
	| { action: "tools" }
	| { action: "doctor" }
	| { action: "health"; model?: string }
	| { action: "invalid"; message: string };

/** Pure argument parser for the unified `/antigravity` root command. */
export function parseAntigravitySubcommand(args: string): AntigravitySubcommand {
	const [head, ...rest] = (args || "").trim().split(/\s+/).filter(Boolean);
	if (head === undefined) return { action: "dashboard" };
	const keyword = head.toLowerCase();
	if (keyword === "models") return { action: "models", all: /\ball\b/i.test(rest.join(" ")) };
	if (keyword === "tools") return { action: "tools" };
	if (keyword === "doctor") return { action: "doctor" };
	if (keyword === "health") return { action: "health", model: rest[0] };
	return { action: "invalid", message: ROOT_HELP };
}

const NO_CREDENTIALS = "No Antigravity credentials. Run /login antigravity first.";

async function resolveCredentials(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const apiKey = await resolveApiKeyFromContext(ctx);
	if (!apiKey) emitCommandOutput(ctx, NO_CREDENTIALS, "warning");
	return apiKey;
}

async function handleModelsCommand(
	ctx: ExtensionCommandContext,
	opts: { all: boolean },
): Promise<void> {
	const apiKey = await resolveCredentials(ctx);
	if (!apiKey) return;
	if (ctx.hasUI) ctx.ui.notify("Refreshing Antigravity models…", "info");
	try {
		const [usage, catalogRes] = await Promise.all([
			runWithDiagnostics(() => fetchAccountModelsUsage(apiKey)),
			refreshModelCatalog(ctx, apiKey),
		]);
		if (!catalogRes.ok && catalogRes.error) {
			emitCommandOutput(ctx, `Antigravity model refresh failed: ${catalogRes.error}`, "warning");
		}
		emitCommandOutput(ctx, formatModelsList(usage, opts));
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		emitCommandOutput(ctx, `Antigravity usage failed: ${redactSecrets(msg)}`, "warning");
	}
}

function activeHealthModel(ctx: ExtensionCommandContext): string | undefined {
	const d = getLastDiagnostics();
	const matchingLastRequest = !ctx.model || ctx.model.id === d.requestedModel;
	return (
		(matchingLastRequest ? d.resolvedRuntimeModel : undefined) ??
		(ctx.model ? getAntigravityRequestModelId(ctx.model.id, undefined) : undefined)
	);
}

const SUBCOMMANDS = [
	{
		value: "models",
		label: "models",
		description: "Sync model catalog and list models with quota",
	},
	{ value: "tools", label: "tools", description: "Show managed Antigravity tools" },
	{ value: "doctor", label: "doctor", description: "Show sanitized provider diagnostics" },
	{
		value: "health",
		label: "health",
		description: "Read persisted model quota health without provider calls",
	},
];

export function registerAntigravityCommands(pi: ExtensionAPI): void {
	const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const parsed = parseAntigravitySubcommand(args);
		if (parsed.action === "invalid") {
			emitCommandOutput(ctx, parsed.message, "warning");
			return;
		}
		if (parsed.action === "health") {
			const model = parsed.model ?? activeHealthModel(ctx);
			if (!model) {
				emitCommandOutput(ctx, "Choose a model or use /antigravity health <runtime-model>.", "warning");
				return;
			}
			try {
				emitCommandOutput(ctx, formatHealthSummary(healthSummary(model)));
			} catch (error) {
				emitCommandOutput(ctx, `Antigravity health unavailable: ${redactSecrets(String(error))}`, "warning");
			}
			return;
		}
		if (ctx.hasUI && ctx.mode === "tui") {
			const initialTab =
				parsed.action === "models"
					? "models"
					: parsed.action === "tools"
						? "tools"
						: parsed.action === "doctor"
							? "doctor"
							: "accounts";
			await runAccountsDashboard(ctx, {
				initialTab,
				showAllModels: parsed.action === "models" ? parsed.all : false,
				pi,
			});
			return;
		}
		if (parsed.action === "models") {
			await handleModelsCommand(ctx, { all: parsed.all });
		} else if (parsed.action === "tools") {
			emitCommandOutput(ctx, formatToolsReport(getAntigravityToolStates()));
		} else if (parsed.action === "doctor") {
			emitCommandOutput(ctx, formatDoctorReport(buildDoctorSnapshot(pi, activeHealthModel(ctx))));
		} else {
			await runAccountsDashboard(ctx, { pi });
		}
	};
	pi.registerCommand("antigravity", {
		description: "Antigravity control center (models | tools | doctor | health [runtime-model])",
		getArgumentCompletions: (prefix) => {
			const needle = prefix.trimStart().toLowerCase();
			return SUBCOMMANDS.filter((item) => item.value.startsWith(needle));
		},
		handler,
	});
	pi.registerCommand("antigravity.usage", {
		description: "Alias of /antigravity",
		handler,
	});
}
