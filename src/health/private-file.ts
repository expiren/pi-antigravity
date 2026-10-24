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

// The path is an environment value, never interpolated into PowerShell source.
// A new file is empty until this ACL has been installed and verified.
const WINDOWS_ACL = `
$ErrorActionPreference = 'Stop'
$p = $env:ANTIGRAVITY_HEALTH_PRIVATE_PATH
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($me.Value, 'S-1-5-18', 'S-1-5-32-544')
$acl = [System.IO.File]::GetAccessControl($p)
if ($env:ANTIGRAVITY_HEALTH_PRIVATE_SET -eq '1') {
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($r in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($r) }
  $acl.SetOwner($me)
  foreach ($s in $allowed) {
    $sid = [System.Security.Principal.SecurityIdentifier]::new($s)
    $r = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid, [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($r)
  }
  [System.IO.File]::SetAccessControl($p, $acl)
  $acl = [System.IO.File]::GetAccessControl($p)
}
if (-not $acl.AreAccessRulesProtected) { throw 'unprotected' }
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $me.Value) {
  throw 'owner'
}
$full = $false
foreach ($r in $acl.Access) {
  $sid = $r.IdentityReference.Translate(
    [System.Security.Principal.SecurityIdentifier]).Value
  if ($r.AccessControlType -ne 'Allow' -or $allowed -notcontains $sid) { throw 'access' }
  if ($sid -eq $me.Value -and
    ($r.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
      [System.Security.AccessControl.FileSystemRights]::FullControl) { $full = $true }
}
if (-not $full) { throw 'rights' }
[Console]::Write('PRIVATE')
`;

function windowsPrivate(path: string, set: boolean): void {
  try {
    const result = execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 4096,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ANTIGRAVITY_HEALTH_PRIVATE_PATH: path,
          ANTIGRAVITY_HEALTH_PRIVATE_SET: set ? "1" : "0",
        },
      },
    );
    if (result.trim() !== "PRIVATE") throw new Error();
  } catch {
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
