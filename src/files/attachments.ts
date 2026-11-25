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
      throw new Error('Incomplete path quotes; use /file "path with spaces" [prompt].');
    }
    if (end === 1) throw new Error("Please provide a file path.");
    return { path: text.slice(1, end), prompt: text.slice(end + 1).trim() };
  }
  const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) throw new Error("Please provide a file path.");
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
    .map((s) => ({
      value: s,
      label: `${s} - ${s === "clear" ? "Unmount file" : "Show mount status"}`,
    }));
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
    description:
      "Mount a single file (PDF, image, audio/video, UTF-8 text); clear/status to manage",
    getArgumentCompletions: (prefix) => completions(prefix, completionCwd),
    handler: async (args, ctx) => {
      completionCwd = ctx.cwd;
      const text = args.trim();
      const { attachment } = current(ctx);
      if (!text || text.toLowerCase() === "status") {
        ctx.ui.notify(
          attachment
            ? `Mounted: ${attachment.displayName}\nPath: ${attachment.absPath}\nType: ${getFileFormat(attachment.absPath)?.mimeType}\nSize at mount: ${(attachment.sizeBytes / 1024 / 1024).toFixed(2)} MiB\nStatus: ${supportsFiles(ctx) ? "active" : "paused (Antigravity Gemini only)"}\nRe-read on change; file content sent with each request.`
            : "No file mounted. Use /file <path> [prompt].",
          "info",
        );
        return;
      }
      // Neither mounting nor detaching may change an in-flight turn's context.
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Agent is busy; wait for the current task to finish before mounting or unmounting.",
          "warning",
        );
        return;
      }
      if (text.toLowerCase() === "clear") {
        pi.appendEntry<FileState>(STATE_TYPE, { version: 1, attachment: null });
        resetCache();
        ctx.ui.notify("File unmounted; subsequent requests will not include attachments.", "info");
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
          throw new Error("Session or branch changed, or the agent started running; please retry.");
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
          `Mounted file: ${reference.displayName} (${(reference.sizeBytes / 1024 / 1024).toFixed(2)} MiB)`,
          "info",
        );
        if (!supportsFiles(ctx)) {
          ctx.ui.notify(
            `Attachment saved but paused; switch to Antigravity Gemini to send.${prompt ? " The attached prompt was not sent." : ""}`,
            "warning",
          );
        } else if (prompt) {
          pi.sendUserMessage(
            `[Attached file: ${JSON.stringify(reference.displayName)}]\n${prompt}`,
          );
        }
      } catch (error) {
        ctx.ui.notify(
          `Unable to mount file: ${error instanceof Error ? error.message : String(error)}`,
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
      warn(
        ctx,
        "File attachment paused: Antigravity Gemini only; will resume after switching back.",
      );
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
    let additions: Array<ImageContent | TextContent>;
    let available = false;
    try {
      const loaded = await reader.load(attachment.absPath);
      // Pi's ImageContent is the existing carrier for arbitrary Gemini inlineData.
      const payload: ImageContent | TextContent =
        loaded.kind === "inline"
          ? { type: "image", mimeType: loaded.mimeType, data: loaded.data }
          : {
              type: "text",
              text: `[Attached file content: ${JSON.stringify(attachment.displayName)}; reference: ${attachment.id}]\n${loaded.data}\n[End attached file content: ${attachment.id}]`,
            };
      // UI mount notifications are not model context. Explain the actual payload,
      // without claiming that backend decoding or interpretation has succeeded.
      additions = [
        {
          type: "text",
          text: `[File attachment provided: ${JSON.stringify(attachment.displayName)}]\nThe file content is included in this request; answer directly from the attachment.`,
        },
        payload,
      ];
      available = true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warn(ctx, `File not sent: ${attachment.displayName} — ${reason}`);
      additions = [
        {
          type: "text",
          text: `[File attachment unavailable: ${JSON.stringify(attachment.displayName)}. ${reason}]`,
        },
      ];
    }
    const missing = additions.filter(
      (addition) =>
        !content.some((b) =>
          addition.type === "image"
            ? b.type === "image" && b.mimeType === addition.mimeType && b.data === addition.data
            : b.type === "text" && b.text === addition.text,
        ),
    );
    if (!missing.length) return;
    messages[target] = { ...message, content: [...content, ...missing] };
    if (Buffer.byteLength(JSON.stringify(messages)) > MAX_CONTEXT_BYTES) {
      warn(
        ctx,
        "File not sent: inline context exceeds the local 18 MiB safety budget; shorten the conversation or split the file.",
      );
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
    } else if (available) {
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
