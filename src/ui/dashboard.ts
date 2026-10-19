import type {
  ExtensionAPI,
  ExtensionCommandContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { isKeyRepeat, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { activateAccount, listAccounts, readAccountApiKeys, removeAccount } from "../auth/index.js";
import { getLastDiagnostics, runWithDiagnostics } from "../diagnostics/index.js";
import {
  applyAntigravityCatalog,
  discoverAntigravityModels,
  getCurrentAntigravityCatalog,
  PROVIDER_ID,
  resolvedCatalog,
} from "../models/index.js";
import {
  getAntigravityToolStates,
  setAllAntigravityToolsEnabled,
  toggleAntigravityTool,
  type AntigravityToolName,
  type AntigravityToolState,
  type ToolActivationController,
} from "../tools/index.js";
import type { AccountUsage, ModelQuotaRow } from "../types/types.js";
import {
  createThemeColorizer,
  deriveUniqueShortLabels,
  fetchAccountUsage,
  formatAccountsDashboard,
  formatQuotaBar,
  formatQuotaCountdown,
  plainDashboardColorizer,
  type DashboardAccountRow,
  type DashboardColorizer,
  type ThemeLike,
} from "../usage/index.js";
import { maskEmail, redactSecrets } from "../utils/index.js";
import { emitCommandOutput } from "./output.js";

export type DashboardTabId = "accounts" | "models" | "tools" | "doctor";

export const DASHBOARD_TABS: readonly {
  id: DashboardTabId;
  index: number;
  label: string;
}[] = [
  { id: "accounts", index: 1, label: "账号" },
  { id: "models", index: 2, label: "模型" },
  { id: "tools", index: 3, label: "工具" },
  { id: "doctor", index: 4, label: "诊断" },
];

export type DoctorSnapshot = {
  provider: string;
  activeAccountLabel: string;
  linkedAccountsCount: number;
  enabledTools: string[];
  totalToolsCount: number;
  resolvedRuntimeModel: string;
  matchedModelDebug: string;
  availableModels: string;
  endpoint: string;
  status?: number;
  latencyMs?: number;
  projectId: string;
  toolSchemaWarnings: string;
  error: string;
};

export type DashboardStatusToast = {
  text: string;
  tone: "info" | "success" | "warning";
};

export type DashboardResult =
  | { action: "switch"; target: DashboardAccountRow }
  | { action: "remove"; target: DashboardAccountRow }
  | { action: "close" };

export type DashboardActions = {
  onSwitchAccount?: (target: DashboardAccountRow) => void | Promise<void>;
  onRemoveAccount?: (target: DashboardAccountRow) => void | Promise<void>;
  onRefreshAccounts?: () => void | Promise<void>;
  onRefreshModels?: () => void | Promise<void>;
  onToggleTool?: (name: AntigravityToolName) => void;
  onToggleAllTools?: () => void;
  onRefreshDoctor?: () => void;
};

export type DashboardComponentOptions = {
  initialTab?: DashboardTabId;
  showAllModels?: boolean;
  tools?: AntigravityToolState[];
  doctor?: DoctorSnapshot;
  actions?: DashboardActions;
};

const MAX_VISIBLE_MODEL_ROWS = 10;

export function buildDoctorSnapshot(pi?: ToolActivationController): DoctorSnapshot {
  const d = getLastDiagnostics();
  const accounts = listAccounts();
  const active = accounts.find((account) => account.active);
  const activeAccountLabel = active
    ? maskEmail(active.email) ||
      (active.accountId.includes("@") ? maskEmail(active.accountId) : active.accountId)
    : "none";
  const toolStates = getAntigravityToolStates();
  const activeSessionSet = pi ? new Set(pi.getActiveTools()) : undefined;
  const enabledTools = toolStates
    .filter((t) => (activeSessionSet ? activeSessionSet.has(t.name) && t.enabled : t.enabled))
    .map((t) => t.name);

  return {
    provider: PROVIDER_ID,
    activeAccountLabel: activeAccountLabel || "none",
    linkedAccountsCount: accounts.length,
    enabledTools,
    totalToolsCount: toolStates.length,
    resolvedRuntimeModel: d.resolvedRuntimeModel || "none",
    matchedModelDebug: d.matchedModelDebug || "none",
    availableModels: d.availableModels || "none",
    endpoint: d.endpoint || "none",
    status: d.status,
    latencyMs: d.latencyMs,
    projectId: d.projectId || "none",
    toolSchemaWarnings: d.toolSchemaWarnings || "none",
    error: d.error ? redactSecrets(d.error) : "none",
  };
}

export function formatDoctorReport(snapshot: DoctorSnapshot): string {
  const lines = [
    `provider=${snapshot.provider}`,
    `lastResolvedRuntimeModel=${snapshot.resolvedRuntimeModel}`,
    `availableModels=${snapshot.availableModels}`,
    `matchedModel=${snapshot.matchedModelDebug}`,
    `lastEndpoint=${snapshot.endpoint}`,
    `lastStatus=${snapshot.status ?? "none"}`,
    `lastProjectId=${snapshot.projectId}`,
    `linkedAccounts=${snapshot.linkedAccountsCount || "none"}`,
    `activeAccount=${snapshot.activeAccountLabel}`,
    `enabledTools=${snapshot.enabledTools.length}/${snapshot.totalToolsCount} (${snapshot.enabledTools.join(",") || "none"})`,
    ...(snapshot.latencyMs !== undefined ? [`lastLatencyMs=${snapshot.latencyMs}`] : []),
    `toolSchemaWarnings=${snapshot.toolSchemaWarnings}`,
    `lastError=${snapshot.error}`,
    "transport=native-streamSimple",
    "runtimeCli=not-used",
    "commands=/antigravity",
  ];
  return `Antigravity doctor\n${lines.join("\n")}`;
}

export function formatToolsReport(tools: AntigravityToolState[]): string {
  const enabledCount = tools.filter((t) => t.enabled).length;
  const lines = [
    `Antigravity tools (${enabledCount}/${tools.length} enabled)`,
    "",
    ...tools.map(
      (t) => `${t.enabled ? "[x]" : "[ ]"} ${t.name.padEnd(16)} ${t.label.padEnd(16)} ${t.summary}`,
    ),
  ];
  return lines.join("\n");
}

/**
 * Dynamic discovery is the same lightweight `fetchAvailableModels` RPC that backs
 * model listing, so refreshing models syncs Pi's catalog first.
 */
export async function refreshModelCatalog(
  ctx: ExtensionCommandContext,
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (typeof ctx.modelRegistry?.refresh === "function") {
      const result = await ctx.modelRegistry.refresh({ force: true, providers: [PROVIDER_ID] });
      if (result?.errors?.has(PROVIDER_ID)) throw result.errors.get(PROVIDER_ID)!;
      return { ok: true };
    }
    const discovered = await discoverAntigravityModels(apiKey);
    if (discovered.models.length > 0) {
      applyAntigravityCatalog(resolvedCatalog(discovered, getCurrentAntigravityCatalog()));
    }
    return { ok: true };
  } catch (error) {
    const msg = redactSecrets(error instanceof Error ? error.message : String(error));
    return { ok: false, error: msg };
  }
}

export function filterVisibleModels(models: ModelQuotaRow[], showAll: boolean): ModelQuotaRow[] {
  return showAll ? models : models.filter((m) => !/tab_|chat_/i.test(m.modelId));
}

export function formatModelsTab(
  activeRow: DashboardAccountRow | undefined,
  options?: {
    showAll?: boolean;
    selectedIndex?: number;
    maxRows?: number;
    refreshing?: boolean;
    colorizer?: DashboardColorizer;
    theme?: ThemeLike;
    now?: number;
  },
): string {
  const colorizer = options?.colorizer || plainDashboardColorizer;
  const th = options?.theme;
  const now = options?.now || Date.now();
  const showAll = Boolean(options?.showAll);
  const maxRows = options?.maxRows ?? MAX_VISIBLE_MODEL_ROWS;

  if (!activeRow) {
    return colorizer.dim("暂无已绑定的 Antigravity 账号，请先执行 /login antigravity 登录。");
  }

  const lines: string[] = [];
  const accountText = colorizer.accountName(activeRow.shortLabel, true);
  const projectText = activeRow.usage?.projectId || "…";
  const viewMode = showAll ? "全部模型" : "常用模型";
  const syncBadge =
    options?.refreshing || activeRow.loading
      ? th
        ? th.fg("warning", "  ⟳ 正在同步目录与配额…")
        : "  ⟳ 正在同步目录与配额…"
      : "";

  lines.push(
    `${colorizer.dim("当前账号:")} ${accountText}   ${colorizer.dim("Project:")} ${colorizer.modelName(projectText)}   ${colorizer.dim("视图:")} ${colorizer.modelName(viewMode)}${syncBadge}`,
  );
  lines.push("");

  if (activeRow.loading && !activeRow.usage) {
    lines.push(colorizer.dim("正在获取模型列表与配额…"));
    return lines.join("\n");
  }

  if (activeRow.error && !activeRow.usage) {
    lines.push(colorizer.countdown(`获取失败: ${activeRow.error}`, true));
    return lines.join("\n");
  }

  const allModels = activeRow.usage?.models || [];
  const models = filterVisibleModels(allModels, showAll);

  if (models.length === 0) {
    lines.push(colorizer.dim("暂无可用模型数据（按 r 重新同步）。"));
    return lines.join("\n");
  }

  const clampedIndex = Math.max(0, Math.min(options?.selectedIndex ?? 0, models.length - 1));
  let start = 0;
  if (models.length > maxRows) {
    const half = Math.floor(maxRows / 2);
    start = Math.max(0, Math.min(clampedIndex - half, models.length - maxRows));
  }
  const visible = models.slice(start, start + maxRows);
  const idWidth = Math.min(28, Math.max(18, ...models.map((m) => m.modelId.length)));

  if (start > 0) {
    lines.push(colorizer.dim(`  ↑ 上方还有 ${start} 个模型`));
  }

  for (let i = 0; i < visible.length; i++) {
    const modelIndex = start + i;
    const m = visible[i];
    const isSelected = modelIndex === clampedIndex;
    const cursor = isSelected ? colorizer.cursor("▸ ") : "  ";
    const truncatedId =
      m.modelId.length > idWidth ? `${m.modelId.slice(0, idWidth - 1)}…` : m.modelId;
    const paddedId = truncatedId.padEnd(idWidth);
    const styledId = isSelected
      ? colorizer.accountName(paddedId, true)
      : colorizer.modelName(paddedId);

    const fraction = m.remainingFraction;
    const barRaw = formatQuotaBar(fraction, 8);
    const barStyled = colorizer.bar(fraction, barRaw);
    const remPct =
      fraction === undefined
        ? "  ?%"
        : `${String(Math.round(Math.max(0, Math.min(1, fraction)) * 100)).padStart(3)}%`;
    const pctStyled = colorizer.percent(fraction, remPct);
    const countdownRaw = formatQuotaCountdown("5h", m.resetTime, fraction, now);
    const countdownStyled = colorizer.countdown(
      countdownRaw,
      fraction !== undefined && fraction < 0.2,
    );

    const badges = [
      m.recommended ? "推荐" : "",
      m.supportsThinking ? "思考" : "",
      m.supportsImages ? "图像" : "",
    ].filter(Boolean);
    const badgeText = badges.length > 0 ? colorizer.dim(`  [${badges.join("·")}]`) : "";

    lines.push(`${cursor}${styledId}  ${barStyled} ${pctStyled} ${countdownStyled}${badgeText}`);
  }

  const remainingBelow = models.length - (start + visible.length);
  if (remainingBelow > 0) {
    lines.push(colorizer.dim(`  ↓ 下方还有 ${remainingBelow} 个模型`));
  }

  lines.push("");
  lines.push(
    colorizer.dim(
      `共 ${models.length} 个模型${!showAll && allModels.length > models.length ? `（已隐藏 ${allModels.length - models.length} 个内部模型，按 a 显示全部）` : ""} · 配额按模型池共享`,
    ),
  );

  return lines.join("\n");
}

export function formatToolsTab(
  tools: AntigravityToolState[],
  options?: {
    selectedIndex?: number;
    colorizer?: DashboardColorizer;
    theme?: ThemeLike;
  },
): string {
  const colorizer = options?.colorizer || plainDashboardColorizer;
  const th = options?.theme;
  const enabledCount = tools.filter((t) => t.enabled).length;

  const lines: string[] = [];
  lines.push(
    `${colorizer.dim("当前状态:")} ${colorizer.accountName(`${enabledCount} / ${tools.length} 已启用`, enabledCount > 0)}  ${colorizer.dim("· 禁用后立即从当前会话移除并自动记住偏好")}`,
  );
  lines.push("");

  const nameWidth = Math.max(15, ...tools.map((t) => t.name.length));

  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    const isSelected = options?.selectedIndex === i;
    const cursor = isSelected ? colorizer.cursor("▸ ") : "  ";
    const badgeRaw = tool.enabled ? "● 已启用" : "○ 已禁用";
    const badge = tool.enabled
      ? th
        ? th.fg("success", badgeRaw)
        : colorizer.activeMarker(badgeRaw)
      : colorizer.dim(badgeRaw);
    const paddedName = tool.name.padEnd(nameWidth);
    const styledName = isSelected
      ? colorizer.accountName(paddedName, true)
      : tool.enabled
        ? colorizer.accountName(paddedName, false)
        : colorizer.dim(paddedName);
    const styledLabel = tool.enabled ? colorizer.modelName(tool.label) : colorizer.dim(tool.label);

    if (i > 0) lines.push("");
    lines.push(`${cursor}${badge}  ${styledName}  ${styledLabel}`);
    lines.push(`            ${colorizer.dim(tool.summary)}`);
  }

  return lines.join("\n");
}

export function formatDoctorTab(
  snapshot: DoctorSnapshot,
  options?: {
    colorizer?: DashboardColorizer;
    theme?: ThemeLike;
  },
): string {
  const colorizer = options?.colorizer || plainDashboardColorizer;
  const th = options?.theme;

  const statusText =
    snapshot.status === undefined
      ? "none"
      : `${snapshot.status}${snapshot.latencyMs !== undefined ? ` (${snapshot.latencyMs}ms)` : ""}`;
  const styledStatus =
    snapshot.status === undefined
      ? colorizer.dim(statusText)
      : snapshot.status >= 200 && snapshot.status < 300
        ? th
          ? th.fg("success", statusText)
          : statusText
        : th
          ? th.fg("warning", statusText)
          : statusText;

  const toolsSummary =
    snapshot.enabledTools.length > 0
      ? `${snapshot.enabledTools.length}/${snapshot.totalToolsCount} (${snapshot.enabledTools.join(", ")})`
      : `0/${snapshot.totalToolsCount} (全部禁用)`;

  const rows: [string, string, boolean?][] = [
    ["Provider", `${snapshot.provider} (native-streamSimple)`],
    [
      "当前账号",
      `${snapshot.activeAccountLabel} (共 ${snapshot.linkedAccountsCount} 个已绑定账号)`,
    ],
    ["工具激活", toolsSummary],
    ["最近解析模型", snapshot.resolvedRuntimeModel],
    ["匹配模型调试", snapshot.matchedModelDebug],
    ["可用模型样本", snapshot.availableModels],
    ["最近请求端点", snapshot.endpoint],
    ["最近响应状态", styledStatus, true],
    ["最近项目 ID", snapshot.projectId],
    ["Schema 警告", snapshot.toolSchemaWarnings],
    ["最近错误", snapshot.error],
  ];

  const labelWidth = 14;
  return rows
    .map(([label, value, preStyled]) => {
      const paddedLabel = label.padEnd(
        labelWidth - [...label].filter((c) => c.charCodeAt(0) > 255).length,
      );
      const val = preStyled
        ? value
        : value === "none"
          ? colorizer.dim(value)
          : colorizer.modelName(value);
      return `  ${colorizer.dim(paddedLabel)}  ${val}`;
    })
    .join("\n");
}

/**
 * Terminal component for the multi-tab Antigravity control center.
 * Tabs:
 *  1. 账号 (Accounts): quota bars, switch account, unlink account
 *  2. 模型 (Models): model quota table, refresh catalog & quotas
 *  3. 工具 (Tools): enable/disable Antigravity tools with persistence
 *  4. 诊断 (Doctor): sanitized provider diagnostics
 */
export class AntigravityDashboardComponent {
  private rows: DashboardAccountRow[];
  private activeTab: DashboardTabId;
  private selectedIndex: number;
  private confirmDeleteIndex?: number;
  private selectedModelIndex = 0;
  private showAllModels: boolean;
  private modelsRefreshing = false;
  private tools: AntigravityToolState[];
  private selectedToolIndex = 0;
  private doctorSnapshot: DoctorSnapshot;
  private statusToast?: DashboardStatusToast;
  private actions: DashboardActions;
  private theme: ThemeLike;
  private keybindings: KeybindingsManager;
  private onDone: (result: DashboardResult) => void;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private settled = false;

  constructor(
    rows: DashboardAccountRow[],
    initialIndex: number,
    theme: ThemeLike,
    keybindings: KeybindingsManager,
    onDone: (result: DashboardResult) => void,
    options?: DashboardComponentOptions,
  ) {
    this.rows = rows;
    this.activeTab = options?.initialTab ?? "accounts";
    this.selectedIndex = Math.max(0, Math.min(initialIndex, Math.max(0, rows.length - 1)));
    this.showAllModels = Boolean(options?.showAllModels);
    this.tools = options?.tools ?? getAntigravityToolStates();
    this.doctorSnapshot = options?.doctor ?? buildDoctorSnapshot();
    this.actions = options?.actions ?? {};
    this.theme = theme;
    this.keybindings = keybindings;
    this.onDone = onDone;
  }

  getTab(): DashboardTabId {
    return this.activeTab;
  }

  setTab(tab: DashboardTabId): void {
    if (this.settled || this.activeTab === tab) return;
    this.activeTab = tab;
    this.confirmDeleteIndex = undefined;
    this.invalidate();
  }

  setStatus(text: string, tone: DashboardStatusToast["tone"] = "info"): void {
    if (this.settled) return;
    this.statusToast = { text, tone };
    this.invalidate();
  }

  setModelsRefreshing(refreshing: boolean): void {
    if (this.settled) return;
    this.modelsRefreshing = refreshing;
    this.invalidate();
  }

  updateTools(tools: AntigravityToolState[]): void {
    if (this.settled) return;
    this.tools = tools;
    this.selectedToolIndex = Math.max(0, Math.min(this.selectedToolIndex, tools.length - 1));
    this.invalidate();
  }

  updateDoctor(snapshot: DoctorSnapshot): void {
    if (this.settled) return;
    this.doctorSnapshot = snapshot;
    this.invalidate();
  }

  updateRows(rows: DashboardAccountRow[], selectedIndex?: number): void {
    if (this.settled) return;
    this.rows = rows;
    if (selectedIndex !== undefined) {
      this.selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, rows.length - 1)));
    } else {
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, rows.length - 1)));
    }
    this.confirmDeleteIndex = undefined;
    this.invalidate();
  }

  updateRowUsage(index: number, usage: AccountUsage): void {
    if (this.settled || !this.rows[index]) return;
    this.rows[index].loading = false;
    this.rows[index].error = undefined;
    this.rows[index].usage = usage;
    this.invalidate();
  }

  setRowError(index: number, error: string): void {
    if (this.settled || !this.rows[index]) return;
    this.rows[index].loading = false;
    this.rows[index].error = error;
    this.invalidate();
  }

  private getActiveAccountRow(): DashboardAccountRow | undefined {
    return this.rows.find((r) => r.active) ?? this.rows[this.selectedIndex] ?? this.rows[0];
  }

  private getVisibleModelsCount(): number {
    const activeRow = this.getActiveAccountRow();
    const models = activeRow?.usage?.models || [];
    return filterVisibleModels(models, this.showAllModels).length;
  }

  private finish(result: DashboardResult): void {
    if (this.settled) return;
    this.settled = true;
    this.onDone(result);
  }

  private cycleTab(delta: number): void {
    const currentIdx = DASHBOARD_TABS.findIndex((t) => t.id === this.activeTab);
    const nextIdx = (currentIdx + delta + DASHBOARD_TABS.length) % DASHBOARD_TABS.length;
    this.activeTab = DASHBOARD_TABS[nextIdx].id;
    this.confirmDeleteIndex = undefined;
    this.statusToast = undefined;
    this.invalidate();
  }

  handleInput(data: string): void {
    if (this.settled) return;

    // Esc / cancel: clear delete confirmation first, otherwise close TUI
    if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "q")) {
      if (this.confirmDeleteIndex !== undefined) {
        this.confirmDeleteIndex = undefined;
        this.invalidate();
        return;
      }
      this.finish({ action: "close" });
      return;
    }

    // Tab navigation: Tab / Shift+Tab / Left / Right / h / l / 1-4
    if (matchesKey(data, "tab") || matchesKey(data, "right") || matchesKey(data, "l")) {
      this.cycleTab(1);
      return;
    }
    if (matchesKey(data, "shift+tab") || matchesKey(data, "left") || matchesKey(data, "h")) {
      this.cycleTab(-1);
      return;
    }
    if (matchesKey(data, "1")) {
      this.setTab("accounts");
      return;
    }
    if (matchesKey(data, "2")) {
      this.setTab("models");
      return;
    }
    if (matchesKey(data, "3")) {
      this.setTab("tools");
      return;
    }
    if (matchesKey(data, "4")) {
      this.setTab("doctor");
      return;
    }

    if (this.activeTab === "accounts") {
      this.handleAccountsInput(data);
      return;
    }
    if (this.activeTab === "models") {
      this.handleModelsInput(data);
      return;
    }
    if (this.activeTab === "tools") {
      this.handleToolsInput(data);
      return;
    }
    if (this.activeTab === "doctor") {
      this.handleDoctorInput(data);
    }
  }

  private handleAccountsInput(data: string): void {
    if (this.rows.length === 0) return;

    if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
      this.confirmDeleteIndex = undefined;
      this.selectedIndex = (this.selectedIndex - 1 + this.rows.length) % this.rows.length;
      this.invalidate();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
      this.confirmDeleteIndex = undefined;
      this.selectedIndex = (this.selectedIndex + 1) % this.rows.length;
      this.invalidate();
      return;
    }

    if (matchesKey(data, "r")) {
      this.confirmDeleteIndex = undefined;
      void this.actions.onRefreshAccounts?.();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.rows[this.selectedIndex];
      if (!selected) return;
      if (this.actions.onSwitchAccount) {
        void this.actions.onSwitchAccount(selected);
      } else {
        this.finish({ action: "switch", target: selected });
      }
      return;
    }

    // Arm with d/x. Confirm with y so key-repeat cannot unlink.
    if (matchesKey(data, "d") || matchesKey(data, "x")) {
      if (isKeyRepeat(data) || this.confirmDeleteIndex === this.selectedIndex) return;
      this.confirmDeleteIndex = this.selectedIndex;
      this.invalidate();
      return;
    }

    if (matchesKey(data, "y") || matchesKey(data, "shift+y")) {
      if (isKeyRepeat(data)) return;
      if (this.confirmDeleteIndex === this.selectedIndex) {
        const selected = this.rows[this.selectedIndex];
        this.confirmDeleteIndex = undefined;
        if (!selected) return;
        if (this.actions.onRemoveAccount) {
          void this.actions.onRemoveAccount(selected);
        } else {
          this.finish({ action: "remove", target: selected });
        }
      }
      return;
    }

    // Any other key resets delete confirmation
    if (this.confirmDeleteIndex !== undefined) {
      this.confirmDeleteIndex = undefined;
      this.invalidate();
    }
  }

  private handleModelsInput(data: string): void {
    const count = this.getVisibleModelsCount();

    if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
      if (count > 0) {
        this.selectedModelIndex = (this.selectedModelIndex - 1 + count) % count;
        this.invalidate();
      }
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
      if (count > 0) {
        this.selectedModelIndex = (this.selectedModelIndex + 1) % count;
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, "a")) {
      this.showAllModels = !this.showAllModels;
      const nextCount = this.getVisibleModelsCount();
      this.selectedModelIndex = Math.max(0, Math.min(this.selectedModelIndex, nextCount - 1));
      this.invalidate();
      return;
    }

    if (matchesKey(data, "r") || this.keybindings.matches(data, "tui.select.confirm")) {
      void this.actions.onRefreshModels?.();
    }
  }

  private handleToolsInput(data: string): void {
    if (this.tools.length === 0) return;

    if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
      this.selectedToolIndex = (this.selectedToolIndex - 1 + this.tools.length) % this.tools.length;
      this.invalidate();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
      this.selectedToolIndex = (this.selectedToolIndex + 1) % this.tools.length;
      this.invalidate();
      return;
    }

    if (matchesKey(data, "space") || this.keybindings.matches(data, "tui.select.confirm")) {
      const target = this.tools[this.selectedToolIndex];
      if (!target) return;
      if (this.actions.onToggleTool) {
        this.actions.onToggleTool(target.name);
      } else {
        const enabled = toggleAntigravityTool(target.name);
        this.tools = getAntigravityToolStates();
        this.statusToast = {
          text: enabled ? `✓ 已启用工具 ${target.name}` : `○ 已禁用工具 ${target.name}`,
          tone: enabled ? "success" : "info",
        };
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, "a")) {
      if (this.actions.onToggleAllTools) {
        this.actions.onToggleAllTools();
      } else {
        const shouldEnableAll = this.tools.some((t) => !t.enabled);
        setAllAntigravityToolsEnabled(shouldEnableAll);
        this.tools = getAntigravityToolStates();
        this.statusToast = {
          text: shouldEnableAll ? "✓ 已启用全部工具" : "○ 已禁用全部工具",
          tone: shouldEnableAll ? "success" : "info",
        };
        this.invalidate();
      }
    }
  }

  private handleDoctorInput(data: string): void {
    if (matchesKey(data, "r") || this.keybindings.matches(data, "tui.select.confirm")) {
      this.actions.onRefreshDoctor?.();
    }
  }

  private renderTabBar(): string {
    const th = this.theme;
    const title = th.bold(th.fg("accent", "Antigravity 控制中心"));
    const tabPills = DASHBOARD_TABS.map((tab) => {
      const isCurrent = tab.id === this.activeTab;
      if (isCurrent) {
        return th.bold(th.fg("accent", `[${tab.index} ${tab.label}]`));
      }
      return th.fg("dim", ` ${tab.index} ${tab.label} `);
    }).join(" ");
    return `  ${title}    ${tabPills}`;
  }

  private renderFooterHint(): string {
    const th = this.theme;
    if (this.activeTab === "accounts") {
      return th.fg(
        "dim",
        "↑↓ 移动 · Enter 切换账号 · r 刷新 · d 解绑 · Tab/←→/1-4 切页 · Esc 退出",
      );
    }
    if (this.activeTab === "models") {
      return th.fg(
        "dim",
        "↑↓ 移动 · r/Enter 刷新模型目录 · a 全部/常用 · Tab/←→/1-4 切页 · Esc 退出",
      );
    }
    if (this.activeTab === "tools") {
      return th.fg(
        "dim",
        "↑↓ 移动 · Space/Enter 启用/禁用 · a 全选/全不选 · Tab/←→/1-4 切页 · Esc 退出",
      );
    }
    return th.fg("dim", "r/Enter 刷新状态 · Tab/←→/1-4 切页 · Esc 退出");
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const th = this.theme;
    const colorizer = createThemeColorizer(th);
    const safeWidth = Math.max(0, width);

    const inner = Math.max(0, safeWidth - 2);
    const ruleChars = Math.min(inner, Math.max(10, safeWidth - 4));
    const hr = th.fg("borderMuted", "─".repeat(ruleChars));

    // Header + Tab Bar
    lines.push("");
    lines.push(truncateToWidth(this.renderTabBar(), safeWidth));
    lines.push(truncateToWidth(`  ${hr}`, safeWidth));
    lines.push("");

    // Body per active tab
    let body: string;
    if (this.activeTab === "accounts") {
      if (this.rows.length === 0) {
        body = colorizer.dim("暂无已绑定的 Antigravity 账号，请先执行 /login antigravity 登录。");
      } else {
        body = formatAccountsDashboard(this.rows, {
          selectedIndex: this.selectedIndex,
          colorizer,
          now: Date.now(),
        });
      }
    } else if (this.activeTab === "models") {
      body = formatModelsTab(this.getActiveAccountRow(), {
        showAll: this.showAllModels,
        selectedIndex: this.selectedModelIndex,
        refreshing: this.modelsRefreshing,
        colorizer,
        theme: th,
        now: Date.now(),
      });
    } else if (this.activeTab === "tools") {
      body = formatToolsTab(this.tools, {
        selectedIndex: this.selectedToolIndex,
        colorizer,
        theme: th,
      });
    } else {
      body = formatDoctorTab(this.doctorSnapshot, {
        colorizer,
        theme: th,
      });
    }

    for (const line of body.split("\n")) {
      lines.push(truncateToWidth(`  ${line}`, safeWidth));
    }

    // Footer
    lines.push("");
    lines.push(truncateToWidth(`  ${hr}`, safeWidth));
    if (this.activeTab === "accounts" && this.confirmDeleteIndex !== undefined) {
      const target = this.rows[this.confirmDeleteIndex];
      const targetName = target ? target.shortLabel : "该账号";
      lines.push(
        truncateToWidth(
          `  ${th.bold(th.fg("warning", `⚠️  确定要解绑 [${targetName}] 吗？按 y 确认，按 Esc 取消`))}`,
          safeWidth,
        ),
      );
    } else {
      if (this.statusToast) {
        const toneColor =
          this.statusToast.tone === "warning"
            ? "warning"
            : this.statusToast.tone === "success"
              ? "success"
              : "accent";
        lines.push(truncateToWidth(`  ${th.fg(toneColor, this.statusToast.text)}`, safeWidth));
      }
      lines.push(truncateToWidth(`  ${this.renderFooterHint()}`, safeWidth));
    }
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export type RunDashboardOptions = {
  initialTab?: DashboardTabId;
  showAllModels?: boolean;
  pi?: ExtensionAPI;
};

async function runInteractiveDashboard(
  ctx: ExtensionCommandContext,
  initialAccess: Awaited<ReturnType<typeof readAccountApiKeys>>,
  initialRows: DashboardAccountRow[],
  initialIndex: number,
  options?: RunDashboardOptions,
): Promise<void> {
  let component: AntigravityDashboardComponent | undefined;
  let closed = false;
  let access = initialAccess;
  let rows = initialRows;
  let requestRender: (() => void) | undefined;
  const sessionNotes: string[] = [];

  const fetchAllAccountsUsage = (currentAccess: typeof access, currentRows: typeof rows) => {
    const promises = currentAccess.map(async (account, index) => {
      if (!account.apiKey) {
        const errMsg = redactSecrets(account.error || "No credentials");
        if (closed || !currentRows[index]) return;
        currentRows[index].loading = false;
        currentRows[index].error = errMsg;
        component?.setRowError(index, errMsg);
        return;
      }
      try {
        const usage = await runWithDiagnostics(() => fetchAccountUsage(account.apiKey), {
          commit: account.active,
        });
        if (closed || !currentRows[index]) return;
        currentRows[index].loading = false;
        currentRows[index].error = undefined;
        currentRows[index].usage = usage;
        component?.updateRowUsage(index, usage);
        if (account.active) {
          component?.updateDoctor(buildDoctorSnapshot(options?.pi));
        }
      } catch (error) {
        if (closed || !currentRows[index]) return;
        const msg = redactSecrets(error instanceof Error ? error.message : String(error));
        currentRows[index].loading = false;
        currentRows[index].error = msg;
        component?.setRowError(index, msg);
      }
    });
    promises.forEach((p) => {
      void p.then(() => {
        if (!closed) requestRender?.();
      });
    });
  };

  const refreshActiveModels = async () => {
    const activeIdx = rows.findIndex((r) => r.active);
    const targetIdx = activeIdx >= 0 ? activeIdx : 0;
    const targetAccess = access[targetIdx];
    if (!targetAccess?.apiKey) {
      component?.setStatus("当前无可用账号凭证，请先执行 /login antigravity", "warning");
      requestRender?.();
      return;
    }

    component?.setModelsRefreshing(true);
    component?.setStatus("⟳ 正在同步 Antigravity 模型目录与配额…", "info");
    requestRender?.();

    const catalogRes = await refreshModelCatalog(ctx, targetAccess.apiKey);
    if (closed) return;

    try {
      const usage = await runWithDiagnostics(() => fetchAccountUsage(targetAccess.apiKey), {
        commit: true,
      });
      if (closed) return;
      if (rows[targetIdx]) {
        rows[targetIdx].loading = false;
        rows[targetIdx].error = undefined;
        rows[targetIdx].usage = usage;
        component?.updateRowUsage(targetIdx, usage);
      }
      component?.updateDoctor(buildDoctorSnapshot(options?.pi));
      component?.setModelsRefreshing(false);
      if (catalogRes.ok) {
        component?.setStatus(
          `✓ 模型目录与配额已同步（共 ${usage.models.length} 个模型）`,
          "success",
        );
      } else {
        component?.setStatus(`⚠ 模型目录同步警告: ${catalogRes.error}`, "warning");
      }
    } catch (error) {
      if (closed) return;
      const msg = redactSecrets(error instanceof Error ? error.message : String(error));
      component?.setModelsRefreshing(false);
      component?.setStatus(`⚠ 配额获取失败: ${msg}`, "warning");
    }
    requestRender?.();
  };

  // Start background fetch for all accounts in parallel immediately
  fetchAllAccountsUsage(access, rows);

  const result = await ctx.ui.custom<DashboardResult>((tui, theme, kb, done) => {
    requestRender = () => {
      if (!closed) tui.requestRender();
    };
    component = new AntigravityDashboardComponent(
      rows,
      initialIndex,
      theme,
      kb,
      (res) => {
        closed = true;
        done(res);
      },
      {
        initialTab: options?.initialTab,
        showAllModels: options?.showAllModels,
        tools: getAntigravityToolStates(),
        doctor: buildDoctorSnapshot(options?.pi),
        actions: {
          onSwitchAccount: async (target) => {
            if (target.active) {
              component?.setStatus(`当前已处于账号 ${target.shortLabel}`, "info");
              requestRender?.();
              return;
            }
            const switched = await activateAccount(String(target.index));
            rows.forEach((r) => {
              r.active = r.accountId === switched.accountId;
            });
            access.forEach((a) => {
              a.active = a.accountId === switched.accountId;
            });
            component?.updateRows(rows);
            component?.updateDoctor(buildDoctorSnapshot(options?.pi));
            component?.setStatus(
              `✓ 已切换到账号 ${target.shortLabel} (${switched.email || switched.accountId})`,
              "success",
            );
            sessionNotes.push(
              `Switched to Antigravity account: ${target.shortLabel} (${switched.email || switched.accountId})`,
            );
            requestRender?.();
          },
          onRemoveAccount: async (target) => {
            const remaining = await removeAccount(String(target.index));
            access = await readAccountApiKeys();
            const shortLabelMap = deriveUniqueShortLabels(access);
            const usageByAccount = new Map(rows.map((r) => [r.accountId, r]));
            rows = access.map((acc, idx) => {
              const prev = usageByAccount.get(acc.accountId);
              return {
                index: idx + 1,
                accountId: acc.accountId,
                email: acc.email,
                shortLabel: shortLabelMap.get(acc.accountId) || acc.email || acc.accountId,
                active: acc.active,
                loading: prev ? prev.loading : true,
                usage: prev?.usage,
                error: prev?.error,
              };
            });
            component?.updateRows(rows);
            component?.updateDoctor(buildDoctorSnapshot(options?.pi));
            const nextNote = remaining
              ? ` 当前激活账号: ${remaining.email || remaining.accountId}`
              : "";
            component?.setStatus(`✓ 已解绑账号 [${target.shortLabel}]。${nextNote}`, "success");
            sessionNotes.push(
              `Antigravity account [${target.shortLabel}] unlinked.${remaining ? ` Active account is now ${remaining.email || remaining.accountId}.` : ""}`,
            );
            requestRender?.();
          },
          onRefreshAccounts: () => {
            for (const row of rows) {
              row.loading = true;
              row.error = undefined;
            }
            component?.updateRows(rows);
            component?.setStatus("⟳ 正在刷新全部账号配额…", "info");
            requestRender?.();
            fetchAllAccountsUsage(access, rows);
          },
          onRefreshModels: async () => {
            await refreshActiveModels();
          },
          onToggleTool: (toolName) => {
            const enabled = toggleAntigravityTool(toolName, options?.pi);
            component?.updateTools(getAntigravityToolStates());
            component?.updateDoctor(buildDoctorSnapshot(options?.pi));
            component?.setStatus(
              enabled
                ? `✓ 已启用工具 ${toolName}（当前会话已立即生效）`
                : `○ 已禁用工具 ${toolName}（已从当前会话移除）`,
              enabled ? "success" : "info",
            );
            requestRender?.();
          },
          onToggleAllTools: () => {
            const current = getAntigravityToolStates();
            const shouldEnableAll = current.some((t) => !t.enabled);
            setAllAntigravityToolsEnabled(shouldEnableAll, options?.pi);
            component?.updateTools(getAntigravityToolStates());
            component?.updateDoctor(buildDoctorSnapshot(options?.pi));
            component?.setStatus(
              shouldEnableAll
                ? `✓ 已启用全部 ${current.length} 个工具（当前会话已立即生效）`
                : "○ 已禁用全部 Antigravity 工具（仅保留模型对话能力）",
              shouldEnableAll ? "success" : "info",
            );
            requestRender?.();
          },
          onRefreshDoctor: () => {
            component?.updateDoctor(buildDoctorSnapshot(options?.pi));
            component?.setStatus("✓ 诊断信息已刷新", "success");
            requestRender?.();
          },
        },
      },
    );

    if (options?.initialTab === "models") {
      void refreshActiveModels();
    }

    return component;
  });
  closed = true;

  if (sessionNotes.length > 0) {
    emitCommandOutput(ctx, sessionNotes[sessionNotes.length - 1]);
    return;
  }

  if (!result || result.action === "close") return;

  if (result.action === "switch") {
    if (result.target.active) {
      emitCommandOutput(ctx, `当前已处于账号 ${result.target.shortLabel}`);
      return;
    }
    const switched = await activateAccount(String(result.target.index));
    emitCommandOutput(
      ctx,
      `Switched to Antigravity account: ${result.target.shortLabel} (${switched.email || switched.accountId})`,
    );
    return;
  }

  const remaining = await removeAccount(String(result.target.index));
  const next = remaining ? ` Active account is now ${remaining.email || remaining.accountId}.` : "";
  emitCommandOutput(ctx, `Antigravity account [${result.target.shortLabel}] unlinked.${next}`);
}

async function runHeadlessDashboard(
  ctx: ExtensionCommandContext,
  access: Awaited<ReturnType<typeof readAccountApiKeys>>,
  rows: DashboardAccountRow[],
): Promise<void> {
  // RPC can forward select(), but not custom() terminal components.
  if (ctx.hasUI) {
    ctx.ui.notify(
      `Fetching usage for ${access.length} account${access.length === 1 ? "" : "s"}…`,
      "info",
    );
  }
  await Promise.all(
    access.map(async (account, index) => {
      if (!account.apiKey) {
        rows[index].loading = false;
        rows[index].error = redactSecrets(account.error || "No credentials");
        return;
      }
      try {
        const usage = await runWithDiagnostics(() => fetchAccountUsage(account.apiKey), {
          commit: account.active,
        });
        rows[index].loading = false;
        rows[index].usage = usage;
      } catch (error) {
        const msg = redactSecrets(error instanceof Error ? error.message : String(error));
        rows[index].loading = false;
        rows[index].error = msg;
      }
    }),
  );

  const dashboardOutput = formatAccountsDashboard(rows, { now: Date.now() });
  const hint = "Open the interactive control center in TUI: /antigravity";
  emitCommandOutput(ctx, `Antigravity accounts\n\n${dashboardOutput}\n\n${hint}`);

  if (!ctx.hasUI || rows.length < 2) return;
  const choices = rows.map((row) => ({
    row,
    label: `${row.active ? "* " : ""}${row.index}. ${row.shortLabel}`,
  }));
  const selected = await ctx.ui.select(
    "Switch Antigravity account",
    choices.map((choice) => choice.label),
  );
  const chosen = choices.find((choice) => choice.label === selected)?.row;
  if (!chosen || chosen.active) return;
  const account = await activateAccount(String(chosen.index));
  emitCommandOutput(ctx, `Switched to ${account.email || account.accountId}`);
}

const NO_CREDENTIALS = "No Antigravity credentials. Run /login antigravity first.";

export async function runAccountsDashboard(
  ctx: ExtensionCommandContext,
  options?: RunDashboardOptions,
): Promise<void> {
  const access = await readAccountApiKeys();
  const shortLabelMap = deriveUniqueShortLabels(access);
  const rows: DashboardAccountRow[] = access.map((acc, index) => ({
    index: index + 1,
    accountId: acc.accountId,
    email: acc.email,
    shortLabel: shortLabelMap.get(acc.accountId) || acc.email || acc.accountId,
    active: acc.active,
    loading: true,
  }));

  const activeIndex = rows.findIndex((r) => r.active);
  const initialIndex = activeIndex >= 0 ? activeIndex : 0;

  if (ctx.hasUI && ctx.mode === "tui") {
    await runInteractiveDashboard(ctx, access, rows, initialIndex, options);
    return;
  }

  if (access.length === 0) {
    emitCommandOutput(ctx, NO_CREDENTIALS, "warning");
    return;
  }
  await runHeadlessDashboard(ctx, access, rows);
}
