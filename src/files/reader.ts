import { constants, type Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { FileValidationError } from "./errors.js";
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
    if (!format)
      throw new FileValidationError(
        "UNSUPPORTED_TYPE",
        "Unsupported file type; Office, archives, and unknown binaries are not supported.",
      );
    const s = await stat(absPath);
    if (!s.isFile())
      throw new FileValidationError("NOT_REGULAR_FILE", "Please select a regular file.");
    if (s.size === 0) throw new FileValidationError("EMPTY_FILE", "File is empty.");
    const limit = format.kind === "text" ? MAX_TEXT_BYTES : MAX_FILE_BYTES;
    if (s.size > limit) {
      throw new FileValidationError(
        "FILE_TOO_LARGE",
        format.kind === "text"
          ? "Text exceeds the local 1 MiB safety limit; split the file."
          : "File exceeds the local 12 MiB safety limit (~16 MiB after Base64); split the file.",
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
        throw new FileValidationError("FILE_CHANGED", "File is being modified; please retry.");
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
        throw new FileValidationError("FILE_CHANGED", "File changed during read; please retry.");
      }
      const content = bytes.subarray(0, length);
      let data: string;
      if (format.kind === "text") {
        try {
          data = new TextDecoder("utf-8", { fatal: true }).decode(content);
        } catch {
          throw new FileValidationError("INVALID_UTF8", "Text must be UTF-8 encoded.");
        }
        if (data.includes("\0"))
          throw new FileValidationError(
            "BINARY_TEXT",
            "Text contains NUL bytes; likely a binary file.",
          );
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
