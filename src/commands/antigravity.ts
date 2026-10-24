import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getLastDiagnostics, runWithDiagnostics } from "../diagnostics/index.js";
import { formatHealthSummary, healthSummary } from "../health/report.js";
import {
  applyAntigravityCatalog,
  discoverAntigravityModels,
  getCurrentAntigravityCatalog,
  PROVIDER_ID,
  resolvedCatalog,
  getAntigravityRequestModelId,
} from "../models/index.js";
import { fetchAccountUsage, formatModelsList, resolveApiKeyFromContext } from "../usage/index.js";
import { emitCommandOutput, runAccountsDashboard } from "../ui/index.js";
import { redactSecrets } from "../utils/index.js";

const ROOT_HELP = "Usage: /antigravity [models | doctor]";

export type AntigravitySubcommand =
  | { action: "dashboard" }
  | { action: "models"; all: boolean }
  | { action: "doctor" }
  | { action: "health"; model?: string }
  | { action: "invalid"; message: string };

/** Pure argument parser for the unified `/antigravity` root command. */
export function parseAntigravitySubcommand(args: string): AntigravitySubcommand {
  const [head, ...rest] = (args || "").trim().split(/\s+/).filter(Boolean);
  if (head === undefined) return { action: "dashboard" };
  const keyword = head.toLowerCase();
  if (keyword === "models") return { action: "models", all: /\ball\b/i.test(rest.join(" ")) };
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

/**
 * Dynamic discovery is the same lightweight `fetchAvailableModels` RPC that backs
 * `/antigravity models`, so listing models always refreshes Pi's catalog first.
 */
async function refreshModelCatalog(ctx: ExtensionCommandContext, apiKey: string): Promise<void> {
  try {
    if (typeof ctx.modelRegistry?.refresh === "function") {
      const result = await ctx.modelRegistry.refresh({ force: true, providers: [PROVIDER_ID] });
      if (result?.errors?.has(PROVIDER_ID)) throw result.errors.get(PROVIDER_ID)!;
      return;
    }
    const discovered = await discoverAntigravityModels(apiKey);
    if (discovered.models.length > 0) {
      applyAntigravityCatalog(resolvedCatalog(discovered, getCurrentAntigravityCatalog()));
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // A refresh failure must not block listing what the account can already use.
    emitCommandOutput(ctx, `Antigravity model refresh failed: ${redactSecrets(msg)}`, "warning");
  }
}

async function handleModelsCommand(
  ctx: ExtensionCommandContext,
  opts: { all: boolean },
): Promise<void> {
  const apiKey = await resolveCredentials(ctx);
  if (!apiKey) return;
  if (ctx.hasUI) ctx.ui.notify("Refreshing Antigravity models…", "info");
  await refreshModelCatalog(ctx, apiKey);
  try {
    const usage = await runWithDiagnostics(() => fetchAccountUsage(apiKey));
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

function handleDoctorCommand(ctx: ExtensionCommandContext): void {
  const d = getLastDiagnostics();
  const model = activeHealthModel(ctx) ?? "unknown";
  const summary = healthSummary(model);
  const lines = [
    `provider=${PROVIDER_ID}`,
    `lastResolvedRuntimeModel=${d.resolvedRuntimeModel || "none"}`,
    `availableModels=${d.availableModels || "none"}`,
    `matchedModel=${d.matchedModelDebug || "none"}`,
    `lastEndpoint=${d.endpoint || "none"}`,
    `lastStatus=${d.status ?? "none"}`,
    `lastProjectId=${d.projectId || "none"}`,
    formatHealthSummary(summary),
    `selectedAccount=${d.healthSelection?.selectedAccount ?? "none"}`,
    `selectionRuntimeModel=${d.healthSelection?.runtimeModel ?? "none"}`,
    `rotationCount=${d.healthSelection?.rotationCount ?? 0}`,
    `skipReasons=${JSON.stringify(d.healthSelection?.skipReasons ?? {})}`,
    `selectionBasis=${d.healthSelection?.basis ?? "unknown"}`,
    `lastRecoveryFailureClass=${d.healthSelection?.lastFailureClass ?? "none"}`,
    ...(d.latencyMs !== undefined ? [`lastLatencyMs=${d.latencyMs}`] : []),
    `toolSchemaWarnings=${d.toolSchemaWarnings || "none"}`,
    `lastError=${
      d.error
        ? redactSecrets(d.error).replace(
            /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
            "[redacted-email]",
          )
        : "none"
    }`,
    "transport=native-streamSimple",
    "runtimeCli=not-used",
    "commands=/antigravity /antigravity models /antigravity doctor /antigravity health [runtime-model]",
  ];
  emitCommandOutput(ctx, `Antigravity doctor\n${lines.join("\n")}`);
}

async function handleAntigravityCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parsed = parseAntigravitySubcommand(args);
  if (parsed.action === "invalid") {
    emitCommandOutput(ctx, parsed.message, "warning");
    return;
  }
  if (parsed.action === "models") {
    await handleModelsCommand(ctx, { all: parsed.all });
    return;
  }
  if (parsed.action === "doctor") {
    try {
      handleDoctorCommand(ctx);
    } catch (error) {
      emitCommandOutput(
        ctx,
        `Antigravity health unavailable: ${redactSecrets(String(error))}`,
        "warning",
      );
    }
    return;
  }
  if (parsed.action === "health") {
    const model = parsed.model ?? activeHealthModel(ctx);
    if (!model) {
      emitCommandOutput(
        ctx,
        "Choose a model or use /antigravity health <runtime-model>.",
        "warning",
      );
      return;
    }
    try {
      emitCommandOutput(ctx, formatHealthSummary(healthSummary(model)));
    } catch (error) {
      emitCommandOutput(
        ctx,
        `Antigravity health unavailable: ${redactSecrets(String(error))}`,
        "warning",
      );
    }
    return;
  }
  await runAccountsDashboard(ctx);
}

const SUBCOMMANDS = [
  {
    value: "models",
    label: "models",
    description: "Sync model catalog and list models with quota",
  },
  { value: "doctor", label: "doctor", description: "Show sanitized provider diagnostics" },
  {
    value: "health",
    label: "health",
    description: "Read persisted model quota health without provider calls",
  },
];

export function registerAntigravityCommands(pi: ExtensionAPI): void {
  pi.registerCommand("antigravity", {
    description: "Antigravity control center (models | doctor | health [runtime-model])",
    getArgumentCompletions: (prefix) => {
      const needle = prefix.trimStart().toLowerCase();
      return SUBCOMMANDS.filter((item) => item.value.startsWith(needle));
    },
    handler: handleAntigravityCommand,
  });

  // Compatibility: muscle-memory alias for the pre-convergence command.
  pi.registerCommand("antigravity.usage", {
    description: "Alias of /antigravity",
    handler: handleAntigravityCommand,
  });
}
