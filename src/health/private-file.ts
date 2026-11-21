import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { HealthStoreError } from "./errors.js";

/** Well-known SIDs that may hold FullControl on a private health file. */
const SYSTEM_SID = "S-1-5-18";
const ADMIN_SID = "S-1-5-32-544";

let cachedUserSid: string | undefined;

function currentUserSid(): string {
  if (cachedUserSid) return cachedUserSid;
  const output = execFileSync("whoami", ["/user", "/fo", "csv"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  // Output: "User Name","SID"\r\n"...\user","S-1-5-..."
  const match = output.match(/"(S-1-[\d-]+)"/);
  if (!match) {
    throw new HealthStoreError("unsafe", "Could not determine the current user SID.");
  }
  cachedUserSid = match[1];
  return cachedUserSid;
}

function windowsPrivate(path: string, set: boolean): void {
  try {
    const sid = currentUserSid();

    if (set) {
      const result = execFileSync("icacls", [
        path,
        "/inheritance:r",
        "/grant:r", `*${sid}:(F)`,
        "/grant:r", `*${SYSTEM_SID}:(F)`,
        "/grant:r", `*${ADMIN_SID}:(F)`,
      ], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!result.includes("Successfully processed")) throw new Error(result);
    }

    // Verify: parse icacls output and check only allowed SIDs with (F), no (I).
    const output = execFileSync("icacls", [path], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!output.includes("Successfully processed")) throw new Error(output);

    // Each ACE line looks like:  SID-OR-NAME:(FLAGS)(RIGHTS)
    // Inherited ACEs have (I) or (OI)(CI)(I) etc.
    // We reject any ACE with (I) and require each non-path line to have (F).
    const lines = output.split(/\r?\n/);
    // First line contains the path; subsequent non-empty lines before "Successfully" are ACEs.
    // ACEs may appear on the same line as the path or on continuation lines.
    const acePart = lines.join(" ").replace(/\s+Successfully processed.*/, "");
    // Extract individual ACE entries: "NAME:(perms)" patterns
    const acePattern = /\S+:\([^)]*\)(?:\([^)]*\))*/g;
    const aces: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = acePattern.exec(acePart)) !== null) {
      aces.push(m[0]);
    }
    if (aces.length === 0 || aces.length > 3) throw new Error("unexpected ACE count");

    for (const ace of aces) {
      if (ace.includes("(I)")) throw new Error("inherited ACE found");
      if (!ace.includes("(F)")) throw new Error("non-full-control ACE");
    }
  } catch (error) {
    if (error instanceof HealthStoreError) throw error;
    throw new HealthStoreError(
      "unsafe",
      "Health file ACL could not be verified. Restore a private owner-only ACL before retrying.",
    );
  }
}

export function rejectSymlinkParents(path: string): void {
  let current = dirname(resolve(path));
  for (;;) {
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new HealthStoreError("unsafe", "Health file directory must not use symbolic links.");
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function ensureHealthDirectory(path: string): void {
  rejectSymlinkParents(path);
  const directory = dirname(resolve(path));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new HealthStoreError("unsafe", "Health file directory is unsafe.");
  }
  if (process.platform !== "win32") {
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
      throw new HealthStoreError(
        "unsafe",
        "Health file directory must be owned by the current user and not writable by others.",
      );
    }
  }
}

export function assertPrivateFile(path: string): Stats {
  rejectSymlinkParents(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new HealthStoreError(
      "unsafe",
      "Health state requires a regular private file, not a link.",
    );
  }
  if (process.platform === "win32") {
    windowsPrivate(path, false);
  } else if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
    throw new HealthStoreError("unsafe", "Health file permissions must be owner-only (0600).");
  }
  return stat;
}

/** The returned descriptor remains empty until its restrictive permissions are verified. */
export function createPrivateFile(path: string): number {
  const fd = openSync(path, "wx", 0o600);
  try {
    if (process.platform === "win32") windowsPrivate(path, true);
    else chmodSync(path, 0o600);
    return fd;
  } catch (error) {
    closeSync(fd);
    unlinkSync(path);
    throw error;
  }
}

export function readPrivateFile(path: string, maxBytes: number): string {
  const before = assertPrivateFile(path);
  if (before.size > maxBytes) {
    throw new HealthStoreError(
      "capacity",
      "Health state exceeds the safe size limit; inspect it locally.",
    );
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size > maxBytes
    ) {
      throw new HealthStoreError("unsafe", "Health file changed while opening; retry the request.");
    }
    // Bound the allocation even if a non-cooperating process appends after fstat.
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > maxBytes) {
      throw new HealthStoreError(
        "capacity",
        "Health state exceeds the safe size limit; inspect it locally.",
      );
    }
    return buffer.toString("utf8", 0, bytes);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a transient lock or gate file without ACL verification.
 * These files are always created by createPrivateFile (which sets the ACL),
 * and can be deleted by concurrent processes at any moment, so spawning
 * PowerShell to verify their ACL is both slow and racy.
 */
export function readLockFile(path: string, maxBytes: number): string {
  rejectSymlinkParents(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) {
      throw new HealthStoreError("unsafe", "Lock file is not a regular private file.");
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > maxBytes) {
      throw new HealthStoreError("unsafe", "Lock file exceeds the size limit.");
    }
    return buffer.toString("utf8", 0, bytes);
  } finally {
    closeSync(fd);
  }
}
