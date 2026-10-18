import { constants, type Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { getFileFormat, validateInlineFile, type FileFormat } from "./formats.js";

// Local safety policies, not claimed Antigravity server limits.
export const MAX_FILE_BYTES = 12 * 1024 * 1024;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_CONTEXT_BYTES = 18 * 1024 * 1024;

export interface LoadedFile extends FileFormat {
  absPath: string;
  fingerprint: string;
  sizeBytes: number;
  // UTF-8 text for text files, base64 for native inline attachments.
  data: string;
}

function fingerprint(s: Stats): string {
  return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
}

export class AttachmentReader {
  private cache: LoadedFile | undefined;

  clear(): void {
    this.cache = undefined;
  }

  async load(absPath: string): Promise<LoadedFile> {
    try {
      return await this.read(absPath);
    } catch (error) {
      // Never fall back to stale bytes if a refresh fails.
      this.clear();
      throw error;
    }
  }

  private async read(absPath: string): Promise<LoadedFile> {
    const format = getFileFormat(absPath);
    if (!format) throw new Error("不支持此文件类型；Office、压缩包和未知二进制文件暂不支持。");
    const s = await stat(absPath);
    if (!s.isFile()) throw new Error("请选择普通文件。");
    if (s.size === 0) throw new Error("文件为空。");
    const limit = format.kind === "text" ? MAX_TEXT_BYTES : MAX_FILE_BYTES;
    if (s.size > limit) {
      throw new Error(
        format.kind === "text"
          ? "文本超过本地 1 MiB 安全上限，请拆分文件。"
          : "文件超过本地 12 MiB 安全上限（Base64 后约 16 MiB），请拆分文件。",
      );
    }
    const key = fingerprint(s);
    if (this.cache?.absPath === absPath && this.cache.fingerprint === key) return this.cache;
    this.clear();
    // Nonblocking open avoids hanging on a FIFO swapped in between stat and open.
    const file = await open(absPath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || fingerprint(before) !== key) {
        throw new Error("文件正在变化，请稍后重试。");
      }
      // Bound allocation and reads even when another process grows the file.
      const bytes = Buffer.alloc(s.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (
        length !== s.size ||
        fingerprint(await file.stat()) !== key ||
        fingerprint(await stat(absPath)) !== key
      ) {
        throw new Error("文件在读取时发生变化，请重试。");
      }
      const content = bytes.subarray(0, length);
      let data: string;
      if (format.kind === "text") {
        try {
          data = new TextDecoder("utf-8", { fatal: true }).decode(content);
        } catch {
          throw new Error("文本必须使用 UTF-8 编码。");
        }
        if (data.includes("\0")) throw new Error("文本包含 NUL 字节，疑似二进制文件。");
      } else {
        validateInlineFile(content, format.mimeType);
        data = content.toString("base64");
      }
      this.cache = { ...format, absPath, fingerprint: key, sizeBytes: length, data };
      return this.cache;
    } finally {
      await file.close();
    }
  }
}
