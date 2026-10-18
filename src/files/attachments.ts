/**
 * Persist file references on the current branch; hydrate only outbound context.
 * Bytes remain on the first user turn after mounting, or a stable restored turn
 * after compaction. This is a local encoding cache, NOT a server-side file cache.
 */
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { getAntigravityRequestModelId, PROVIDER_ID } from "../models/models.js";
import { antigravityEnv } from "../utils/util.js";
import { getFileFormat } from "./formats.js";
import { AttachmentReader, MAX_CONTEXT_BYTES } from "./reader.js";

const STATE_TYPE = "antigravity:file-v1";

interface FileReference {
  id: string;
  absPath: string;
  displayName: string;
  sizeBytes: number;
  mountedAt: number;
  fingerprint: string;
}
interface FileState {
  version: 1;
  attachment: FileReference | null;
}

function parseArgs(args: string): { path: string; prompt: string } {
  const text = args.trim();
  if (text.startsWith('"') || text.startsWith("'")) {
    const end = text.indexOf(text[0], 1);
    if (end < 0 || (text[end + 1] && !/\s/.test(text[end + 1]))) {
      throw new Error('路径引号不完整；用 /file "含空格的路径" [问题]。');
    }
    if (end === 1) throw new Error("请提供文件路径。");
    return { path: text.slice(1, end), prompt: text.slice(end + 1).trim() };
  }
  const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) throw new Error("请提供文件路径。");
  return { path: match[1], prompt: match[2] || "" };
}

function absolutePath(cwd: string, path: string): string {
  return resolve(
    cwd,
    path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path,
  );
}

function isReference(value: unknown): value is FileReference {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<FileReference>;
  return (
    typeof p.id === "string" &&
    !!p.id &&
    typeof p.absPath === "string" &&
    isAbsolute(p.absPath) &&
    !!getFileFormat(p.absPath) &&
    typeof p.displayName === "string" &&
    typeof p.fingerprint === "string" &&
    typeof p.sizeBytes === "number" &&
    Number.isFinite(p.sizeBytes) &&
    p.sizeBytes > 0 &&
    typeof p.mountedAt === "number" &&
    Number.isFinite(p.mountedAt)
  );
}

function supportsFiles(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  if (model?.provider !== PROVIDER_ID || !model.id.toLowerCase().startsWith("gemini-"))
    return false;
  // Honor runtime overrides too: an Antigravity model can route to Claude/GPT.
  const runtime =
    antigravityEnv("RUNTIME_MODEL")?.trim() ||
    getAntigravityRequestModelId(model.id, ctx.thinkingLevel);
  return runtime.toLowerCase().startsWith("gemini-");
}

function userText(message: UserMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
}

function completions(prefix: string, cwd: string): AutocompleteItem[] | null {
  const trimmed = prefix.trimStart();
  const quote = trimmed.startsWith('"') || trimmed.startsWith("'") ? trimmed[0] : "";
  const path = quote ? trimmed.slice(1) : trimmed;
  if ((quote && path.includes(quote)) || (!quote && /\s/.test(path))) return null;
  const results: AutocompleteItem[] = ["clear", "status"]
    .filter((s) => s.startsWith(trimmed.toLowerCase()))
    .map((s) => ({ value: s, label: `${s} - ${s === "clear" ? "卸载文件" : "查看挂载状态"}` }));
  const slash = path.lastIndexOf("/");
  const directory = path.slice(0, slash + 1);
  const start = path.slice(slash + 1).toLowerCase();
  try {
    for (const entry of readdirSync(absolutePath(cwd, directory || "."), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || !entry.name.toLowerCase().startsWith(start)) continue;
      if (!entry.isDirectory() && !(entry.isFile() && getFileFormat(entry.name))) continue;
      const value = `${directory}${entry.name}${entry.isDirectory() ? "/" : ""}`;
      const q = quote || (/\s/.test(value) ? '"' : "");
      results.push({
        value: q ? `${q}${value}${entry.isDirectory() ? "" : q}` : value,
        label: value,
      });
    }
  } catch {
    // Completion is best-effort; mounting reports filesystem errors.
  }
  return results.length ? results : null;
}

export function registerFileAttachments(pi: ExtensionAPI): void {
  const reader = new AttachmentReader();
  let cacheOwner: string | undefined;
  let lastWarning: string | undefined;
  let completionCwd = process.cwd();

  function resetCache() {
    reader.clear();
    cacheOwner = undefined;
    lastWarning = undefined;
  }

  // Replay ONLY the current branch. Resume/fork/tree/compaction must never
  // resurrect a mount from a sibling branch.
  function current(ctx: ExtensionContext) {
    const branch = ctx.sessionManager.getBranch();
    let mountIndex = -1;
    let attachment: FileReference | null = null;
    for (let i = 0; i < branch.length; i++) {
      const entry = branch[i];
      if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
      const state = entry.data as Partial<FileState> | undefined;
      attachment = state?.version === 1 && isReference(state.attachment) ? state.attachment : null;
      mountIndex = i;
    }
    const owner = attachment ? `${ctx.sessionManager.getSessionId()}:${attachment.id}` : undefined;
    if (owner !== cacheOwner) {
      resetCache();
      cacheOwner = owner;
    }
    return { branch, mountIndex, attachment };
  }

  function warn(ctx: ExtensionContext, message: string) {
    if (lastWarning !== message) ctx.ui.notify(message, "warning");
    lastWarning = message;
  }

  pi.registerCommand("file", {
    description: "挂载单个文件（PDF、图片、音视频、UTF-8 文本）；clear/status 管理附件",
    getArgumentCompletions: (prefix) => completions(prefix, completionCwd),
    handler: async (args, ctx) => {
      completionCwd = ctx.cwd;
      const text = args.trim();
      const { attachment } = current(ctx);
      if (!text || text.toLowerCase() === "status") {
        ctx.ui.notify(
          attachment
            ? `当前挂载: ${attachment.displayName}\n路径: ${attachment.absPath}\n类型: ${getFileFormat(attachment.absPath)?.mimeType}\n挂载时大小: ${(attachment.sizeBytes / 1024 / 1024).toFixed(2)} MiB\n状态: ${supportsFiles(ctx) ? "启用" : "暂停（仅 Antigravity Gemini）"}\n文件变化时重新读取；每次请求仍传输文件内容。`
            : "当前没有挂载文件。使用 /file <路径> [问题]。",
          "info",
        );
        return;
      }
      // Neither mounting nor detaching may change an in-flight turn's context.
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent 正在忙碌，请等待当前任务结束再挂载或卸载文件。", "warning");
        return;
      }
      if (text.toLowerCase() === "clear") {
        pi.appendEntry<FileState>(STATE_TYPE, { version: 1, attachment: null });
        resetCache();
        ctx.ui.notify("已卸载文件；后续请求不再还原附件。", "info");
        return;
      }
      try {
        const { path, prompt } = parseArgs(text);
        const absPath = absolutePath(ctx.cwd, path);
        const sessionId = ctx.sessionManager.getSessionId();
        const leafId = ctx.sessionManager.getLeafId();
        const loaded = await reader.load(absPath);
        if (
          !ctx.isIdle() ||
          ctx.sessionManager.getSessionId() !== sessionId ||
          ctx.sessionManager.getLeafId() !== leafId
        ) {
          throw new Error("会话或分支已变化，或 Agent 已开始运行；请重试。");
        }
        const reference: FileReference = {
          id: randomUUID(),
          absPath,
          displayName: basename(absPath),
          sizeBytes: loaded.sizeBytes,
          mountedAt: Date.now(),
          fingerprint: loaded.fingerprint,
        };
        pi.appendEntry<FileState>(STATE_TYPE, { version: 1, attachment: reference });
        cacheOwner = `${sessionId}:${reference.id}`;
        lastWarning = undefined;
        ctx.ui.notify(
          `已挂载文件: ${reference.displayName} (${(reference.sizeBytes / 1024 / 1024).toFixed(2)} MiB)`,
          "info",
        );
        if (!supportsFiles(ctx)) {
          ctx.ui.notify(
            `附件已保存但暂停发送；请切换到 Antigravity Gemini 后再提问。${prompt ? "附带的问题未发送。" : ""}`,
            "warning",
          );
        } else if (prompt) {
          pi.sendUserMessage(
            `[Attached file: ${JSON.stringify(reference.displayName)}]\n${prompt}`,
          );
        }
      } catch (error) {
        ctx.ui.notify(
          `无法挂载文件: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  // No input hook: Pi owns the ! / !! shell shortcuts.
  pi.on("context", async (event, ctx) => {
    const { branch, mountIndex, attachment } = current(ctx);
    if (!attachment || !event.messages.length) return;
    if (!supportsFiles(ctx)) {
      warn(ctx, "文件附件已暂停发送：仅支持 Antigravity Gemini；切回后自动恢复。");
      return;
    }
    const sourceIndex = branch.findIndex(
      (e, i) => i > mountIndex && e.type === "message" && e.message.role === "user",
    );
    const source = branch[sourceIndex];
    if (source?.type !== "message" || source.message.role !== "user") return;
    const sourceEdit = branch
      .slice()
      .reverse()
      .find((e) => e.type === "context_edit" && e.targetId === source.id);
    if (sourceEdit?.type === "context_edit" && sourceEdit.replacement === null) return;
    const sourceMessage: UserMessage =
      sourceEdit?.type === "context_edit" && sourceEdit.replacement
        ? { ...source.message, content: sourceEdit.replacement.content as UserMessage["content"] }
        : source.message;
    const restoredMarker = `[Attached file: ${JSON.stringify(attachment.displayName)}]\n[File reference: ${attachment.id}; restored after context compaction]`;
    let target = event.messages.findIndex(
      (m) =>
        m.role === "user" &&
        m.timestamp === sourceMessage.timestamp &&
        userText(m) === userText(sourceMessage),
    );
    if (target < 0)
      target = event.messages.findIndex(
        (m) =>
          m.role === "user" &&
          m.timestamp === attachment.mountedAt &&
          userText(m).startsWith(restoredMarker),
      );
    const messages = event.messages.slice();
    if (target < 0) {
      const compaction = branch
        .slice()
        .reverse()
        .find((e) => e.type === "compaction");
      const firstKept =
        compaction?.type === "compaction"
          ? compaction.firstKeptEntryId
            ? branch.findIndex((e) => e.id === compaction.firstKeptEntryId)
            : branch.indexOf(compaction)
          : -1;
      // Restore only when compaction removed the source, not when an explicit
      // context edit or another extension intentionally omitted it.
      if (firstKept <= sourceIndex) return;
      messages.unshift({ role: "user", content: restoredMarker, timestamp: attachment.mountedAt });
      target = 0;
    }
    const message = messages[target];
    if (message.role !== "user") return;
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    let addition: ImageContent | TextContent;
    try {
      const loaded = await reader.load(attachment.absPath);
      // Pi's ImageContent is the existing carrier for arbitrary Gemini inlineData.
      addition =
        loaded.kind === "inline"
          ? { type: "image", mimeType: loaded.mimeType, data: loaded.data }
          : {
              type: "text",
              text: `[Attached file content: ${JSON.stringify(attachment.displayName)}; reference: ${attachment.id}]\n${loaded.data}\n[End attached file content: ${attachment.id}]`,
            };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warn(ctx, `文件未发送: ${attachment.displayName} — ${reason}`);
      addition = {
        type: "text",
        text: `[File attachment unavailable: ${JSON.stringify(attachment.displayName)}. ${reason}]`,
      };
    }
    const same = (b: ImageContent | TextContent) =>
      addition.type === "image"
        ? b.type === "image" && b.mimeType === addition.mimeType && b.data === addition.data
        : b.type === "text" && b.text === addition.text;
    if (content.some(same)) return;
    messages[target] = { ...message, content: [...content, addition] };
    if (Buffer.byteLength(JSON.stringify(messages)) > MAX_CONTEXT_BYTES) {
      warn(ctx, "文件未发送：内联后的上下文超过本地 18 MiB 安全预算，请压缩对话或拆分文件。");
      messages[target] = {
        ...message,
        content: [
          ...content,
          {
            type: "text",
            text: "[File attachment unavailable: local inline context byte budget exceeded.]",
          },
        ],
      };
    } else if (
      addition.type === "image" ||
      !addition.text.startsWith("[File attachment unavailable:")
    ) {
      lastWarning = undefined;
    }
    return { messages };
  });

  pi.on("session_start", (_event, ctx) => {
    completionCwd = ctx.cwd;
    resetCache();
  });
  pi.on("session_tree", () => resetCache());
  pi.on("session_shutdown", () => resetCache());
}
