import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runWithDiagnostics } from "../diagnostics/index.js";
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

const ROOT_HELP = "Usage: /antigravity [models | tools | doctor]";

export type AntigravitySubcommand =
  | { action: "dashboard" }
  | { action: "models"; all: boolean }
  | { action: "tools" }
  | { action: "doctor" }
  | { action: "invalid"; message: string };

/** Pure argument parser for the unified `/antigravity` root command. */
export function parseAntigravitySubcommand(args: string): AntigravitySubcommand {
  const [head, ...rest] = (args || "").trim().split(/\s+/).filter(Boolean);
  if (head === undefined) return { action: "dashboard" };
  const keyword = head.toLowerCase();
  if (keyword === "models") return { action: "models", all: /\ball\b/i.test(rest.join(" ")) };
  if (keyword === "tools") return { action: "tools" };
  if (keyword === "doctor") return { action: "doctor" };
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

export function registerAntigravityCommands(pi: ExtensionAPI): void {
  pi.registerCommand("antigravity", {
    description: "Antigravity 控制中心（账号 · 模型刷新 · 工具管理 · 诊断）",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const parsed = parseAntigravitySubcommand(args);
      if (parsed.action === "invalid") {
        emitCommandOutput(ctx, parsed.message, "warning");
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
        return;
      }
      if (parsed.action === "tools") {
        emitCommandOutput(ctx, formatToolsReport(getAntigravityToolStates()));
        return;
      }
      if (parsed.action === "doctor") {
        emitCommandOutput(ctx, formatDoctorReport(buildDoctorSnapshot(pi)));
        return;
      }
      await runAccountsDashboard(ctx, { pi });
    },
  });
}
