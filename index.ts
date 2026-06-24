import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Dirent } from "node:fs";

// Color constants for terminal output
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const RESET = "\x1b[0m";

// Resource limits so a pathological tree cannot exhaust memory.
// Override with DIFFOLD_MAX_DEPTH / DIFFOLD_MAX_FILES.
const DEFAULT_MAX_DEPTH = 256;
const DEFAULT_MAX_FILES = 500_000;

function readLimit(name: string, fallback: number): number {
  try {
    if (typeof process === "undefined" || !process.env) return fallback;
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) return fallback;
    return parsed;
  } catch {
    // Deno without --allow-env throws on process.env access
    return fallback;
  }
}

const MAX_DEPTH = readLimit("DIFFOLD_MAX_DEPTH", DEFAULT_MAX_DEPTH);
const MAX_FILES = readLimit("DIFFOLD_MAX_FILES", DEFAULT_MAX_FILES);

// Paths and filenames are attacker-influenced: strip ANSI/control sequences
// before printing so a crafted name cannot rewrite the user's terminal.
const ANSI_ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

function sanitizeForDisplay(value: string): string {
  return value.replace(ANSI_ESCAPE, "").replace(CONTROL_CHARS, "");
}

// Usage always shows the published binary name, regardless of the runtime
// the source was launched with; the README documents source execution.
const RUNNER = "diffold";

const rawDirs = process.argv.slice(2);
if (rawDirs.length < 2 || rawDirs.length > 5) {
  console.error(
    `${RED}Usage: ${RUNNER} <dir1> <dir2> [... <dirN>] (2-5 directories)${RESET}`,
  );
  process.exit(1);
}

function normalizePath(p: string): string {
  let normalized = p.trim();
  if (normalized.startsWith("~")) {
    normalized = normalized.replace(/^~/, os.homedir());
  }
  normalized = normalized.replace(/^([a-zA-Z]):[/\\]?/, "$1:/");
  return path.resolve(normalized);
}

const dirs = rawDirs.map(normalizePath);
const validDirs: string[] = [];
const validFiles: Set<string>[] = [];

// Bash-style shells (Git Bash, MSYS2) strip unquoted backslashes before the
// argument ever reaches us — e.g. F:\a\b pasted from VS Code arrives as
// F:\ab, which is unrecoverable. Detect the mangled shape (a drive letter
// followed by no path separators) and point the user at quoting instead.
function maybePrintWindowsShellHint(original: string): void {
  const trimmed = original.trim();
  if (!/^[A-Za-z]:[\\/]?[^\\/]*$/.test(trimmed)) return;
  console.error(
    `${YELLOW}HINT: "${sanitizeForDisplay(trimmed)}" looks like a Windows path that lost its backslashes. Quote it ("F:\\dir\\sub") or use forward slashes (F:/dir/sub).${RESET}`,
  );
}

// Validates an argument and resolves it to a canonical absolute path.
// Resolving once up-front closes the TOCTOU window between validation and
// traversal, and gives traversal a stable, symlink-free root.
async function resolveDirectory(
  input: string,
  original: string,
): Promise<string | null> {
  try {
    const stat = await fs.stat(input);
    if (!stat.isDirectory()) {
      console.error(
        `${RED}ERROR: ${sanitizeForDisplay(input)} is not a directory${RESET}`,
      );
      return null;
    }
    return await fs.realpath(input);
  } catch (err: unknown) {
    const shown = sanitizeForDisplay(input);
    const isEnoent =
      typeof err === "object" && err !== null && "code" in err &&
      err.code === "ENOENT";
    if (isEnoent) {
      console.error(`${RED}ERROR: Directory does not exist: ${shown}${RESET}`);
      maybePrintWindowsShellHint(original);
    } else {
      const detail = err instanceof Error
        ? ` (${sanitizeForDisplay(err.message)})`
        : "";
      console.error(
        `${RED}ERROR: Cannot access directory${detail}: ${shown}${RESET}`,
      );
    }
    return null;
  }
}

async function getRelativeFiles(root: string): Promise<Set<string>> {
  const files = new Set<string>();
  const resolvedRoot = path.resolve(root);
  const rootPrefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : resolvedRoot + path.sep;
  const stack: Array<{ dir: string; depth: number }> = [
    { dir: resolvedRoot, depth: 0 },
  ];

  while (stack.length > 0) {
    const { dir: currentDir, depth } = stack.pop()!;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (err: unknown) {
      const detail = err instanceof Error
        ? sanitizeForDisplay(err.message)
        : String(err);
      console.error(
        `${YELLOW}[skip] ${sanitizeForDisplay(currentDir)}: ${detail}${RESET}`,
      );
      continue;
    }

    for (const entry of entries) {
      // Symlinks are never followed: cannot escape the root or loop forever.
      if (entry.isSymbolicLink()) continue;

      const resolved = path.resolve(currentDir, entry.name);

      // Containment guard on resolved paths, not on a relative-path prefix.
      if (resolved !== resolvedRoot && !resolved.startsWith(rootPrefix)) {
        continue;
      }

      const relPath = path.relative(resolvedRoot, resolved).replace(/\\/g, "/");
      if (!relPath) continue;

      if (entry.isDirectory()) {
        if (depth + 1 > MAX_DEPTH) {
          throw new Error(
            `Directory tree exceeds DIFFOLD_MAX_DEPTH (${MAX_DEPTH}) at ${sanitizeForDisplay(resolved)}`,
          );
        }
        stack.push({ dir: resolved, depth: depth + 1 });
        continue;
      }

      files.add(relPath);
      if (files.size > MAX_FILES) {
        throw new Error(
          `More than DIFFOLD_MAX_FILES (${MAX_FILES}) files under ${sanitizeForDisplay(resolvedRoot)}`,
        );
      }
    }
  }

  return files;
}

async function main() {
  // Validate and collect valid dirs/files
  for (let i = 0; i < dirs.length; i++) {
    const resolved = await resolveDirectory(dirs[i], rawDirs[i]);
    if (resolved === null) continue;
    const files = await getRelativeFiles(resolved);
    validDirs.push(resolved);
    validFiles.push(files);
  }

  if (validFiles.length < 2) {
    console.error(`${RED}ERROR: Need at least 2 valid directories${RESET}`);
    process.exit(1);
  }

  console.log(
    `${YELLOW}\n=== Folder Diff Report (${validFiles.length} valid folders) ===\n${RESET}`,
  );

  for (let i = 0; i < validFiles.length; i++) {
    let othersUnion = new Set<string>();
    for (let j = 0; j < validFiles.length; j++) {
      if (i !== j) {
        for (const f of validFiles[j]) othersUnion.add(f);
      }
    }
    const unique = new Set(
      [...validFiles[i]].filter((f) => !othersUnion.has(f)),
    );
    const missing = new Set(
      [...othersUnion].filter((f) => !validFiles[i].has(f)),
    );

    console.log(
      `Folder ${i + 1}: ${validFiles[i].size} total files (${BLUE}${sanitizeForDisplay(validDirs[i])}${RESET}):`,
    );
    const uniqueColor = unique.size > 0 ? RED : "";
    const missingColor = missing.size > 0 ? RED : "";
    console.log(
      `  Unique: ${uniqueColor}${unique.size}${RESET} | Missing: ${missingColor}${missing.size}${RESET}`,
    );
    if (unique.size > 0) {
      console.log("  Unique files:");
      [...unique].sort().forEach((f) => console.log(`    ${sanitizeForDisplay(f)}`));
    }
    if (missing.size > 0) {
      console.log("  Missing files:");
      [...missing].sort().forEach((f) => console.log(`    ${sanitizeForDisplay(f)}`));
    }
    console.log("");
  }

  // Common to ALL valid
  let commonAll = validFiles[0] || new Set();
  for (let i = 1; i < validFiles.length; i++) {
    commonAll = new Set([...commonAll].filter((f) => validFiles[i].has(f)));
  }
  console.log(
    `Common to all ${validFiles.length} folders: ${GREEN}${commonAll.size}${RESET} files`,
  );

  console.log(
    `${YELLOW}\nSupports ~ (home) for linux/windows and both forward and back slashes: / \\ as separators.${RESET}`,
  );
  console.log(
    `${YELLOW}Supports Windows drives (f:/   f:\\   f://   f:\\\\  and  f:)${RESET}`,
  );
}

main().catch((err: unknown) => {
  console.error(
    `${RED}FATAL: ${err instanceof Error ? err.message : String(err)}${RESET}`,
  );
  process.exit(1);
});
