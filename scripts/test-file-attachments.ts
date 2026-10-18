import { expect } from "bun:test";
import { mkdtemp, mkdir, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ContextEvent,
  ContextEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Api, Context, ImageContent, Model, UserMessage } from "@earendil-works/pi-ai";
import { registerFileAttachments } from "../src/files/index.ts";
import { getFileFormat, validateInlineFile } from "../src/files/formats.ts";
import {
  AttachmentReader,
  MAX_CONTEXT_BYTES,
  MAX_FILE_BYTES,
  MAX_TEXT_BYTES,
} from "../src/files/reader.ts";
import { buildRequest } from "../src/stream/stream.ts";

const dir = await mkdtemp(join(tmpdir(), "pi-antigravity-files-"));
const model = {
  api: "antigravity-api",
  provider: "antigravity",
  id: "gemini-3.8-flash",
  name: "Gemini",
  baseUrl: "https://cloudcode-pa.googleapis.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1048576,
  maxTokens: 65536,
} as Model<Api>;

type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
type Hook = (
  event: ContextEvent,
  ctx: ExtensionContext,
) => Promise<ContextEventResult | void> | ContextEventResult | void;

function harness() {
  const commands = new Map<string, Command>();
  const hooks = new Map<string, Hook>();
  const notices: Array<{ message: string; level?: string }> = [];
  const sent: unknown[] = [];
  let branch: SessionEntry[] = [];
  let sessionId = "session-1";
  let idle = true;
  let next = 0;
  const base = () => ({
    id: `entry-${++next}`,
    parentId: branch.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
  });
  const user = (content = "Analyze the attachment"): UserMessage => {
    const message: UserMessage = { role: "user", content, timestamp: ++next };
    branch.push({ ...base(), type: "message", message });
    return message;
  };
  const ctx = {
    cwd: dir,
    model: { ...model },
    isIdle: () => idle,
    ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => sessionId,
      getLeafId: () => branch.at(-1)?.id ?? null,
    },
  } as unknown as ExtensionCommandContext;
  const pi = {
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    on: (event: string, hook: Hook) => hooks.set(event, hook),
    appendEntry: (customType: string, data: unknown) => {
      branch.push({ ...base(), type: "custom", customType, data });
    },
    sendUserMessage: (text: string) => {
      sent.push(text);
      user(text);
    },
  } as unknown as ExtensionAPI;
  registerFileAttachments(pi);
  const event = async (name: string, messages: ContextEvent["messages"] = []) =>
    hooks.get(name)?.({ type: "context", messages }, ctx);
  return {
    ctx, commands, hooks, notices, sent, user, base, event,
    branch: () => branch,
    setBranch: (value: SessionEntry[]) => { branch = value; },
    setSession: (value: string) => { sessionId = value; },
    setIdle: (value: boolean) => { idle = value; },
    mount: (args: string) => commands.get("file")!.handler(args, ctx),
    hydrate: async (messages: ContextEvent["messages"]) =>
      (await event("context", messages))?.messages ?? messages,
  };
}

function images(messages: ContextEvent["messages"]): ImageContent[] {
  return messages.flatMap((message) => message.role === "user" && Array.isArray(message.content)
    ? message.content.filter((b) => b.type === "image") : []);
}

function attachmentGuidance(messages: ContextEvent["messages"]): string[] {
  return messages.flatMap((message) => message.role === "user" && Array.isArray(message.content)
    ? message.content.flatMap((b) => b.type === "text" && b.text.startsWith("[File attachment provided:")
      ? [b.text] : []) : []);
}

function messages(h: ReturnType<typeof harness>): ContextEvent["messages"] {
  return h.branch().flatMap((e) => e.type === "message" ? [e.message] : []);
}

let passed = 0;
async function check(name: string, run: () => Promise<void> | void) {
  try {
    await run();
    passed++;
  } catch (error) {
    throw new Error(`File attachment test failed: ${name}`, { cause: error });
  }
}

// Small container fixtures exercise validation/routing, not backend media decoding.
const nativeFixtures: Array<[string, string, Buffer]> = [
  ["report.PDF", "application/pdf", Buffer.from("%PDF-1.7\nfixture")],
  ["photo.png", "image/png", Buffer.from("89504e470d0a1a0a", "hex")],
  ["photo.jpeg", "image/jpeg", Buffer.from("ffd8ff", "hex")],
  ["photo.webp", "image/webp", Buffer.from("RIFF0000WEBP")],
  ["photo.heic", "image/heic", Buffer.from("0000ftypheic")],
  ["photo.heif", "image/heif", Buffer.from("0000ftypheif")],
  ["sound.wav", "audio/wav", Buffer.from("RIFF0000WAVE")],
  ["sound.mp3", "audio/mp3", Buffer.from("ID3fixture")],
  ["sound.aiff", "audio/aiff", Buffer.from("FORM0000AIFF")],
  ["sound.aac", "audio/aac", Buffer.from("fff100", "hex")],
  ["sound.m4a", "audio/mp4", Buffer.from("0000ftypM4A ")],
  ["upper.M4A", "audio/mp4", Buffer.from("0000ftypisom")],
  ["sound.ogg", "audio/ogg", Buffer.from("OggSfixture")],
  ["sound.flac", "audio/flac", Buffer.from("fLaCfixture")],
  ["clip.mp4", "video/mp4", Buffer.from("0000ftypisom")],
  ["clip.mov", "video/mov", Buffer.from("0000ftypqt  ")],
  ["clip.avi", "video/avi", Buffer.from("RIFF0000AVI ")],
  ["clip.webm", "video/webm", Buffer.from("1a45dfa3", "hex")],
  ["clip.mpeg", "video/mpeg", Buffer.from("000001ba", "hex")],
  ["clip.mpg", "video/mpg", Buffer.from("000001b3", "hex")],
  ["clip.flv", "video/x-flv", Buffer.from("FLVfixture")],
  ["clip.wmv", "video/wmv", Buffer.from("3026b2758e66cf11a6d900aa0062ce6c", "hex")],
  ["clip.3gp", "video/3gpp", Buffer.from("0000ftyp3gp4")],
];

const envKeys = ["ANTIGRAVITY_RUNTIME_MODEL", "NOAGY_RUNTIME_MODEL"] as const;
const savedEnv = envKeys.map((key) => process.env[key]);
for (const key of envKeys) delete process.env[key];

try {
  await writeFile(join(dir, "note.md"), "# Hello\nUTF-8 内容");
  await writeFile(join(dir, "with spaces.md"), "quoted path");
  await mkdir(join(dir, "nested directory"));
  await writeFile(join(dir, "office.docx"), "not supported");

  await check("only /file is registered; shell input stays untouched", () => {
    const h = harness();
    expect([...h.commands.keys()]).toEqual(["file"]);
    expect(h.hooks.has("input")).toBe(false);
    expect(h.hooks.has("before_provider_request")).toBe(false);
  });

  await check("all native MIME types survive the full provider request builder", async () => {
    for (const [name, mimeType, bytes] of nativeFixtures) {
      await writeFile(join(dir, name), bytes);
      const h = harness();
      await h.mount(name);
      const raw = [h.user()];
      const hydrated = await h.hydrate(raw);
      expect(images(hydrated)).toEqual([{ type: "image", mimeType, data: bytes.toString("base64") }]);
      const request = buildRequest(model, { messages: hydrated } as Context, "test-project", {}, model.id);
      expect(request.request.contents.flatMap((turn) => turn.parts).filter((p) => "inlineData" in p))
        .toEqual([{ inlineData: { mimeType, data: bytes.toString("base64") } }]);
      expect(typeof raw[0].content).toBe("string");
      expect(JSON.stringify(h.branch())).not.toContain(bytes.toString("base64"));
      expect(await h.hydrate(hydrated)).toEqual(hydrated);
    }
  });

  await check("model-visible guidance accompanies native/text payloads, with or without a mount prompt", async () => {
    for (const file of ["report.PDF", "sound.m4a", "clip.mp4", "note.md"]) {
      for (const prompt of ["", "Summarize this file"]) {
        const h = harness();
        await h.mount(`${file} ${prompt}`);
        if (!prompt) h.user("What is in this file?");
        const raw = messages(h);
        const persisted = JSON.stringify(h.branch());
        const hydrated = await h.hydrate(raw);
        const guidance = attachmentGuidance(hydrated);
        expect(guidance).toHaveLength(1);
        expect(guidance[0]).toBe(`[File attachment provided: ${JSON.stringify(file)}]\nThe file content is included in this request; answer directly from the attachment.`);
        const request = buildRequest(model, { messages: hydrated } as Context, "p", {}, model.id);
        expect(request.request.contents.flatMap((turn) => turn.parts))
          .toContainEqual({ text: guidance[0] });
        expect(attachmentGuidance(raw)).toHaveLength(0);
        expect(JSON.stringify(h.branch())).toBe(persisted);
        expect(await h.hydrate(hydrated)).toEqual(hydrated);
        h.user("Follow up");
        expect(attachmentGuidance(await h.hydrate(messages(h)))).toEqual(guidance);
      }
    }
  });

  await check("M4A uses an MP4 container, not a raw AAC header", () => {
    expect(getFileFormat("recording.m4a")).toEqual({ kind: "inline", mimeType: "audio/mp4" });
    expect(() => validateInlineFile(Buffer.from("0000ftypM4A "), "audio/mp4")).not.toThrow();
    expect(() => validateInlineFile(Buffer.from("fff100", "hex"), "audio/mp4")).toThrow();
    expect(() => validateInlineFile(Buffer.from("0000ftypM4A "), "audio/aac")).toThrow();
  });

  await check("text extensions use plain text, not fake images", async () => {
    for (const name of ["source.ts", "table.csv", "data.json", "page.html", "settings.yaml", "Dockerfile"]) {
      await writeFile(join(dir, name), "hello 世界");
      expect(getFileFormat(name)?.kind).toBe("text");
      const h = harness();
      await h.mount(name);
      const result = await h.hydrate([h.user()]);
      expect(images(result)).toHaveLength(0);
      expect(JSON.stringify(result)).toContain("hello 世界");
      const request = buildRequest(model, { messages: result } as Context, "p", {}, model.id);
      expect(JSON.stringify(request.request.contents)).toContain("hello 世界");
      expect(JSON.stringify(h.branch())).not.toContain("hello 世界");
      expect(await h.hydrate(result)).toEqual(result);
    }
  });

  await check("quoted paths and prompts; metadata only", async () => {
    const h = harness();
    await h.mount('"with spaces.md" Summarize\nplease');
    expect(h.sent).toEqual(['[Attached file: "with spaces.md"]\nSummarize\nplease']);
    expect(h.branch().filter((e) => e.type === "custom")).toHaveLength(1);
    expect(JSON.stringify(h.branch())).not.toContain("quoted path");
    expect(JSON.stringify(await h.hydrate(messages(h)))).toContain("quoted path");
    await h.mount("status");
    expect(h.notices.at(-1)?.message).toContain("text/plain");
    for (const malformed of ['"unfinished', '"note.md"suffix', '"" question']) {
      const before = h.branch().length;
      await h.mount(malformed);
      expect(h.branch()).toHaveLength(before);
      expect(h.notices.at(-1)?.level).toBe("error");
    }
  });

  await check("completion uses session cwd, excludes Office and prompt text", async () => {
    const h = harness();
    await h.event("session_start");
    const complete = h.commands.get("file")!.getArgumentCompletions!;
    const all = (await complete(""))!;
    expect(all.some((v) => v.value === "status")).toBe(true);
    expect(all.some((v) => v.value === "note.md")).toBe(true);
    expect(all.some((v) => v.value === "sound.m4a")).toBe(true);
    expect(all.some((v) => v.value === "office.docx")).toBe(false);
    expect(all.some((v) => v.value === '"with spaces.md"')).toBe(true);
    expect(all.some((v) => v.value === '"nested directory/')).toBe(true);
    expect(await complete('"note.md" prompt')).toBeNull();
    expect(await complete("note.md prompt")).toBeNull();
  });

  await check("unsupported types and invalid headers never mount or submit prompts", async () => {
    for (const name of ["office.docx", "a.xlsx", "a.pptx", "a.doc", "a.zip", "a.bin", "bad.pdf", "bad.png", "bad.m4a"]) {
      await writeFile(join(dir, name), "bad data");
      const h = harness();
      await h.mount(`${name} analyze`);
      expect(h.branch()).toHaveLength(0);
      expect(h.sent).toHaveLength(0);
      expect(h.notices.at(-1)?.level).toBe("error");
    }
    for (const [, mimeType] of nativeFixtures) {
      expect(() => validateInlineFile(Buffer.from("bad data"), mimeType)).toThrow();
    }
  });

  await check("reader rejects empty/non-UTF8/NUL/directory and bounded sizes", async () => {
    const reader = new AttachmentReader();
    for (const [name, data] of [
      ["empty.txt", Buffer.alloc(0)],
      ["nonutf8.txt", Buffer.from([0xff, 0xfe])],
      ["binary.txt", Buffer.from("a\0b")],
    ] as const) {
      const path = join(dir, name);
      await writeFile(path, data);
      await expect(reader.load(path)).rejects.toThrow();
    }
    await mkdir(join(dir, "folder.pdf"));
    await expect(reader.load(join(dir, "folder.pdf"))).rejects.toThrow(/普通文件/);
    for (const [name, limit] of [["big.pdf", MAX_FILE_BYTES], ["big.txt", MAX_TEXT_BYTES]] as const) {
      const path = join(dir, name);
      await writeFile(path, "x");
      await truncate(path, limit + 1);
      await expect(reader.load(path)).rejects.toThrow(/安全上限/);
    }
  });

  await check("reader caches unchanged bytes, refreshes changes/replacements, drops failures", async () => {
    const path = join(dir, "changing.txt");
    const reader = new AttachmentReader();
    await writeFile(path, "initial");
    const first = await reader.load(path);
    expect(await reader.load(path)).toBe(first);
    await writeFile(path, "updated text");
    expect((await reader.load(path)).data).toBe("updated text");
    await writeFile(join(dir, "replacement.txt"), "replacement");
    await rename(join(dir, "replacement.txt"), path);
    expect((await reader.load(path)).data).toBe("replacement");
    await rm(path);
    await expect(reader.load(path)).rejects.toThrow();
    await writeFile(path, "back");
    expect((await reader.load(path)).data).toBe("back");
    reader.clear();
  });

  await check("attachment stays on first user turn, including later tool loops", async () => {
    const h = harness();
    await h.mount("report.PDF");
    h.user("first question");
    const raw = [h.user("second question")];
    // Another extension omitting the source is not compaction.
    expect(await h.hydrate(raw)).toEqual(raw);
    const persisted = JSON.stringify(h.branch());
    const hydrated = await h.hydrate(messages(h));
    expect(images(hydrated.slice(0, 1))).toHaveLength(1);
    expect(images(hydrated.slice(1))).toHaveLength(0);
    expect(JSON.stringify(h.branch())).toBe(persisted);
    expect(await h.hydrate(messages(h))).toEqual(hydrated);
  });

  await check("compaction restores one stable reference turn for native and text files", async () => {
    for (const file of ["report.PDF", "note.md"]) {
      const h = harness();
      await h.mount(file);
      h.user("source");
      const kept = h.user("kept");
      const keptId = h.branch().at(-1)!.id;
      h.branch().push({ ...h.base(), type: "compaction", summary: "Summary", firstKeptEntryId: keptId, tokensBefore: 100 });
      const hydrated = await h.hydrate([kept]);
      expect(hydrated).toHaveLength(2);
      expect(JSON.stringify(hydrated[0])).toContain("restored after context compaction");
      expect(attachmentGuidance(hydrated)).toHaveLength(1);
      expect(await h.hydrate([kept])).toEqual(hydrated);
      expect(await h.hydrate(hydrated)).toEqual(hydrated);
      expect(h.branch().filter((e) => e.type === "custom")).toHaveLength(1);
    }
    const h = harness();
    await h.mount("report.PDF");
    h.user("source");
    h.branch().push({ ...h.base(), type: "compaction", summary: "Summary", firstKeptEntryId: "", tokensBefore: 100 });
    expect(images(await h.hydrate([h.user("after compaction")]))).toHaveLength(1);
  });

  await check("explicit context deletions/replacements respected, even after compaction", async () => {
    const h = harness();
    await h.mount("report.PDF");
    const source = h.user("old text");
    const sourceId = h.branch().at(-1)!.id;
    h.branch().push({ ...h.base(), type: "context_edit", targetId: sourceId, replacement: { content: "edited text" } });
    const edited = { ...source, content: "edited text" };
    expect(images(await h.hydrate([edited]))).toHaveLength(1);
    h.branch().push({ ...h.base(), type: "context_edit", targetId: sourceId, replacement: null });
    const kept = h.user("next");
    h.branch().push({ ...h.base(), type: "compaction", summary: "Summary", firstKeptEntryId: h.branch().at(-1)!.id, tokensBefore: 100 });
    expect(await h.hydrate([kept])).toEqual([kept]);
  });

  await check("clear, branch navigation, resume/fork, session reset", async () => {
    const h = harness();
    await h.mount("report.PDF");
    h.user("original");
    const originalBranch = h.branch().slice();
    const originalMessages = messages(h);
    await h.mount("note.md");
    h.user("new mount");
    const newResult = await h.hydrate(messages(h));
    expect(images(newResult)).toHaveLength(0);
    expect(JSON.stringify(newResult)).toContain("UTF-8 内容");
    h.setBranch([]);
    await h.event("session_tree");
    expect(images(await h.hydrate(originalMessages))).toHaveLength(0);
    h.setBranch(originalBranch.slice());
    h.setSession("forked-session");
    await h.event("session_start");
    expect(images(await h.hydrate(originalMessages))).toHaveLength(1);
    await h.event("session_shutdown");
    expect(images(await h.hydrate(originalMessages))).toHaveLength(1);
    await h.mount("clear");
    expect(images(await h.hydrate(originalMessages))).toHaveLength(0);
    await h.mount("status");
    expect(h.notices.at(-1)?.message).toContain("当前没有挂载文件");
  });

  await check("busy runs reject both mount and clear; async branch races are rejected", async () => {
    const h = harness();
    await h.mount("report.PDF");
    const count = h.branch().length;
    h.setIdle(false);
    await h.mount("note.md question");
    await h.mount("clear");
    expect(h.branch()).toHaveLength(count);
    expect(h.sent).toHaveLength(0);
    await h.mount("status");
    expect(h.notices.at(-1)?.message).toContain("report.PDF");
    h.setIdle(true);
    const mount = h.mount("note.md");
    h.user("branch advanced while reading");
    await mount;
    expect(h.notices.at(-1)?.message).toContain("会话或分支已变化");
    expect(h.branch().filter((e) => e.type === "custom")).toHaveLength(1);
  });

  await check("model/provider/runtime guards pause attachments and never submit false prompts", async () => {
    const h = harness();
    await h.mount("report.PDF");
    const raw = [h.user()];
    for (const [provider, id] of [["antigravity", "claude-sonnet-4-6"], ["antigravity", "gpt-oss-120b"], ["google", "gemini-3.8-flash"]]) {
      h.ctx.model = { ...model, provider, id };
      expect(await h.hydrate(raw)).toEqual(raw);
    }
    h.ctx.model = undefined;
    await h.mount("note.md question");
    expect(h.sent).toHaveLength(0);
    expect(h.notices.at(-1)?.message).toContain("问题未发送");
    h.ctx.model = model;
    await h.mount("report.PDF");
    const freshRaw = [h.user()];
    process.env.ANTIGRAVITY_RUNTIME_MODEL = "claude-sonnet-4-6";
    expect(await h.hydrate(freshRaw)).toEqual(freshRaw);
    delete process.env.ANTIGRAVITY_RUNTIME_MODEL;
    process.env.NOAGY_RUNTIME_MODEL = "gpt-oss-120b";
    expect(await h.hydrate(freshRaw)).toEqual(freshRaw);
    delete process.env.NOAGY_RUNTIME_MODEL;
    expect(images(await h.hydrate(freshRaw))).toHaveLength(1);
  });

  await check("missing/invalid files report unavailability, deduplicate warnings, recover", async () => {
    const path = join(dir, "vanishing.pdf");
    await writeFile(path, "%PDF-initial");
    const h = harness();
    await h.mount("vanishing.pdf");
    const raw = [h.user()];
    expect(images(await h.hydrate(raw))).toHaveLength(1);
    await rm(path);
    const unavailable = await h.hydrate(raw);
    expect(images(unavailable)).toHaveLength(0);
    expect(attachmentGuidance(unavailable)).toHaveLength(0);
    expect(JSON.stringify(unavailable)).toContain("attachment unavailable");
    const noticeCount = h.notices.length;
    await h.hydrate(raw);
    expect(h.notices).toHaveLength(noticeCount);
    await writeFile(path, "%PDF-restored-new");
    const restored = await h.hydrate(raw);
    expect(images(restored)[0].data).toBe(Buffer.from("%PDF-restored-new").toString("base64"));
    expect(attachmentGuidance(restored)).toHaveLength(1);
    await writeFile(path, "invalid pdf");
    const invalid = await h.hydrate(raw);
    expect(images(invalid)).toHaveLength(0);
    expect(attachmentGuidance(invalid)).toHaveLength(0);
    expect(JSON.stringify(await h.hydrate(raw))).toContain("文件头");
  });

  await check("context byte budget removes only new attachment, not existing messages", async () => {
    for (const file of ["report.PDF", "note.md"]) {
      const h = harness();
      await h.mount(file);
      const source = h.user();
      const huge = h.user("x".repeat(MAX_CONTEXT_BYTES));
      const raw = [source, huge];
      const result = await h.hydrate(raw);
      expect(images(result)).toHaveLength(0);
      expect(attachmentGuidance(result)).toHaveLength(0);
      expect(JSON.stringify(result[0])).toContain("local inline context byte budget exceeded");
      expect(result[1]).toBe(huge);
      expect(typeof source.content).toBe("string");
    }
  });

  console.log(`scripts/test-file-attachments.ts: ${passed} checks passed`);
} finally {
  await rm(dir, { recursive: true, force: true });
  for (let i = 0; i < envKeys.length; i++) {
    const value = savedEnv[i];
    if (value === undefined) delete process.env[envKeys[i]];
    else process.env[envKeys[i]] = value;
  }
}
