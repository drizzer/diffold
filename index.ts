import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

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

const rawArgs = process.argv.slice(2);
const rawDirs: string[] = [];
const excludePatterns: string[] = [];
let compareContent = true;
let jsonOutput = false;

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === "-c" || arg === "--no-content") {
    compareContent = false;
    continue;
  }
  if (arg === "--json") {
    jsonOutput = true;
    continue;
  }
  if (arg === "-e" || arg === "--exclude") {
    const pattern = rawArgs[i + 1];
    if (pattern === undefined || pattern.trim() === "") {
      console.error(`${RED}ERROR: ${arg} requires a non-empty pattern${RESET}`);
      process.exit(1);
    }
    excludePatterns.push(pattern);
    i++;
    continue;
  }
  if (arg.startsWith("--exclude=")) {
    const pattern = arg.slice("--exclude=".length);
    if (pattern.trim() === "") {
      console.error(`${RED}ERROR: --exclude requires a non-empty pattern${RESET}`);
      process.exit(1);
    }
    excludePatterns.push(pattern);
    continue;
  }
  if (arg.startsWith("-") && arg !== "-") {
    console.error(`${RED}ERROR: Unknown option: ${sanitizeForDisplay(arg)}${RESET}`);
    process.exit(1);
  }
  rawDirs.push(arg);
}

if (rawDirs.length < 2 || rawDirs.length > 5) {
  console.error(
    `${RED}Usage: ${RUNNER} <dir1> <dir2> [... <dirN>] [options] (2-5 directories)${RESET}`,
  );
  console.error(
    `${RED}Options: -c, --no-content  Compare paths only (content comparison is on by default)${RESET}`,
  );
  console.error(`${RED}         --json            Print a machine-readable report to stdout${RESET}`);
  console.error(`${RED}Options: -e, --exclude <glob>  Exclude matching files/directories (repeatable)${RESET}`);
  process.exit(1);
}

for (let i = 0; i < rawDirs.length; i++) {
  if (!rawDirs[i] || rawDirs[i].trim() === "") {
    console.error(
      `${RED}ERROR: Directory argument ${i + 1} is empty or whitespace-only${RESET}`,
    );
    process.exit(1);
  }
}

function normalizePath(p: string): string {
  // Empty and whitespace-only arguments are rejected before this point.
  // Otherwise preserve the supplied name exactly, including significant
  // leading or trailing spaces.
  let normalized = p;
  if (normalized === "~") {
    normalized = os.homedir();
  } else if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    normalized = path.join(os.homedir(), normalized.slice(2));
  }
  // Drive-letter normalization is Windows-only. On POSIX a name such as
  // "c:notes" is an ordinary relative path and must not become "c:/notes".
  if (process.platform === "win32") {
    normalized = normalized.replace(/^([a-zA-Z]):[/\\]?/, "$1:/");
  }
  return path.resolve(normalized);
}

const dirs = rawDirs.map(normalizePath);
const validDirs: string[] = [];
const validFiles: Set<string>[] = [];
const skippedDirsByFolder: string[][] = [];

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

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.-]/g, "\\$&");
}

interface ExcludeMatcher {
  path: RegExp;
  segment: RegExp | null;
}

function globToRegExp(pattern: string): ExcludeMatcher {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  const isSegmentPattern = !normalized.includes("/");
  let source = "";
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        i++;
        if (normalized[i + 1] === "/") {
          i++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }
  const pathMatcher = normalized.endsWith("/**")
    ? new RegExp(`^${source.slice(0, -3)}(?:/.*)?$`)
    : new RegExp(`^${source}$`);
  const segmentMatcher = isSegmentPattern
    ? new RegExp(`(?:^|/)${source}(?=/|$)`)
    : null;
  return { path: pathMatcher, segment: segmentMatcher };
}

const excludeMatchers = excludePatterns.map(globToRegExp);

function isExcluded(relativePath: string): boolean {
  return excludeMatchers.some(
    (matcher) => matcher.path.test(relativePath) ||
      matcher.segment?.test(relativePath) === true,
  );
}

async function getRelativeFiles(root: string): Promise<{
  files: Set<string>;
  skippedDirs: string[];
}> {
  const files = new Set<string>();
  const skippedDirs: string[] = [];
  const resolvedRoot = path.resolve(root);
  const rootPrefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : resolvedRoot + path.sep;
  let scannedEntries = 0;
  const stack: Array<{ dir: string; depth: number }> = [
    { dir: resolvedRoot, depth: 0 },
  ];

  while (stack.length > 0) {
    const { dir: currentDir, depth } = stack.pop()!;

    let dirHandle: Awaited<ReturnType<typeof fs.opendir>> | null = null;
    try {
      dirHandle = await fs.opendir(currentDir);
    } catch (err: unknown) {
      const detail = err instanceof Error
        ? sanitizeForDisplay(err.message)
        : String(err);
      console.error(
        `${YELLOW}[skip] ${sanitizeForDisplay(currentDir)}: ${detail}${RESET}`,
      );
      skippedDirs.push(currentDir);
      continue;
    }

    try {
      for await (const entry of dirHandle) {
        // Symlinks are never followed: cannot escape the root or loop forever.
        if (entry.isSymbolicLink()) continue;

        const resolved = path.resolve(currentDir, entry.name);

        // Containment guard on resolved paths, not on a relative-path prefix.
        if (resolved !== resolvedRoot && !resolved.startsWith(rootPrefix)) {
          continue;
        }

        const relPath = path.relative(resolvedRoot, resolved).replace(/\\/g, "/");
        if (!relPath || isExcluded(relPath)) continue;

        // Every non-excluded visited entry consumes traversal budget, so a tree made only
        // of empty directories cannot bypass DIFFOLD_MAX_FILES.
        scannedEntries++;
        if (scannedEntries > MAX_FILES) {
          throw new Error(
            `More than DIFFOLD_MAX_FILES (${MAX_FILES}) entries under ${sanitizeForDisplay(resolvedRoot)}`,
          );
        }

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
      }
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.message.includes("DIFFOLD_MAX_DEPTH") ||
          err.message.includes("DIFFOLD_MAX_FILES"))
      ) {
        throw err;
      }
      const detail = err instanceof Error
        ? sanitizeForDisplay(err.message)
        : String(err);
      console.error(
        `${YELLOW}[skip] ${sanitizeForDisplay(currentDir)}: ${detail}${RESET}`,
      );
      skippedDirs.push(currentDir);
    } finally {
      try {
        await dirHandle.close();
      } catch {
        // for-await already closes the handle on normal completion, break, or
        // throw; ignore the resulting ERR_DIR_CLOSED.
      }
    }
  }

  return { files, skippedDirs };
}

interface FileFingerprint {
  size: number;
  hash: string;
}

interface ContentDifference {
  path: string;
  groups: number[][];
}

interface JsonReport {
  schemaVersion: 1;
  contentComparison: "sha256" | "disabled";
  folders: Array<{
    path: string;
    totalFiles: number;
    skippedDirectories: string[];
  }>;
  unique: string[][];
  missing: string[][];
  common: string[];
  identical: string[];
  modified: ContentDifference[];
  incomplete: boolean;
}

async function fingerprintFile(filePath: string): Promise<FileFingerprint> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { size: stat.size, hash: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function compareCommonContent(
  roots: string[],
  commonAll: Set<string>,
): Promise<ContentDifference[]> {
  if (!compareContent) return [];

  const differences: ContentDifference[] = [];
  for (const relativePath of [...commonAll].sort()) {
    const fingerprints: FileFingerprint[] = [];
    for (let folderIndex = 0; folderIndex < roots.length; folderIndex++) {
      const fingerprint = await fingerprintFile(
        path.join(roots[folderIndex], ...relativePath.split("/")),
      );
      fingerprints.push(fingerprint);
    }

    const groups = new Map<string, number[]>();
    for (let folderIndex = 0; folderIndex < fingerprints.length; folderIndex++) {
      const fingerprint = fingerprints[folderIndex];
      const key = `${fingerprint.size}:${fingerprint.hash}`;
      const group = groups.get(key);
      if (group) {
        group.push(folderIndex);
      } else {
        groups.set(key, [folderIndex]);
      }
    }

    if (groups.size > 1) {
      const orderedGroups = [...groups.values()].sort(
        (left, right) => left[0] - right[0],
      );
      differences.push({ path: relativePath, groups: orderedGroups });
    }
  }
  return differences;
}

function getFolderDifferences(fileSets: Set<string>[]): {
  unique: Set<string>[];
  missing: Set<string>[];
} {
  const unique: Set<string>[] = [];
  const missing: Set<string>[] = [];

  for (let i = 0; i < fileSets.length; i++) {
    let othersUnion = new Set<string>();
    for (let j = 0; j < fileSets.length; j++) {
      if (i !== j) {
        for (const file of fileSets[j]) othersUnion.add(file);
      }
    }
    unique.push(new Set(
      [...fileSets[i]].filter((file) => !othersUnion.has(file)),
    ));
    missing.push(new Set(
      [...othersUnion].filter((file) => !fileSets[i].has(file)),
    ));
  }

  return { unique, missing };
}

function getCommonFiles(fileSets: Set<string>[]): Set<string> {
  let common = fileSets[0] || new Set<string>();
  for (let i = 1; i < fileSets.length; i++) {
    common = new Set([...common].filter((file) => fileSets[i].has(file)));
  }
  return common;
}

function printHumanReport(
  differences: { unique: Set<string>[]; missing: Set<string>[] },
  commonAll: Set<string>,
  contentDifferences: ContentDifference[],
  identicalCount: number,
): void {
  console.log(
    `${YELLOW}\n=== Folder Diff Report (${validFiles.length} valid folders) ===\n${RESET}`,
  );

  for (let i = 0; i < validFiles.length; i++) {
    const unique = differences.unique[i];
    const missing = differences.missing[i];
    console.log(
      `Folder ${i + 1}: ${validFiles[i].size} total files (${BLUE}${sanitizeForDisplay(validDirs[i])}${RESET}):`,
    );
    const uniqueColor = unique.size > 0 ? RED : "";
    const missingColor = missing.size > 0 ? RED : "";
    const skippedCount = skippedDirsByFolder[i]?.length ?? 0;
    const skippedNote = skippedCount > 0
      ? ` [${skippedCount} director${skippedCount === 1 ? "y" : "ies"} skipped]`
      : "";
    console.log(
      `  Unique: ${uniqueColor}${unique.size}${RESET} | Missing: ${missingColor}${missing.size}${RESET}${skippedNote}`,
    );
    if (unique.size > 0) {
      console.log("  Unique files:");
      [...unique].sort().forEach((file) => console.log(`    ${sanitizeForDisplay(file)}`));
    }
    if (missing.size > 0) {
      console.log("  Missing files:");
      [...missing].sort().forEach((file) => console.log(`    ${sanitizeForDisplay(file)}`));
    }
    console.log("");
  }

  console.log(
    `Common to all ${validFiles.length} folders: ${GREEN}${commonAll.size}${RESET} files`,
  );
  if (compareContent) {
    console.log(
      `Content: ${GREEN}${identicalCount} identical${RESET} | ${contentDifferences.length > 0 ? RED : ""}${contentDifferences.length} changed${RESET}`,
    );
    if (contentDifferences.length > 0) {
      console.log("  Changed files:");
      for (const difference of contentDifferences) {
        const groups = difference.groups
          .map((group) => `Folders ${group.map((index) => index + 1).join(", ")}`)
          .join(" != ");
        console.log(`    ${sanitizeForDisplay(difference.path)}: ${groups}`);
      }
    }
  } else {
    console.log("Content: comparison disabled (-c)");
  }

  console.log(
    `${YELLOW}\nSupports ~ (home) for linux/windows and both forward and back slashes: / \\ as separators.${RESET}`,
  );
  console.log(
    `${YELLOW}Supports Windows drives (f:/   f:\\   f://   f:\\\\  and  f:)${RESET}`,
  );
}

async function main() {
  // Collect every validation error before deciding. A user who asked for
  // three folders and mistyped one must get an error, not a silent two-folder
  // report with exit code 0.
  let failedArguments = 0;
  for (let i = 0; i < dirs.length; i++) {
    const resolved = await resolveDirectory(dirs[i], rawDirs[i]);
    if (resolved === null) {
      failedArguments++;
      continue;
    }
    const traversal = await getRelativeFiles(resolved);
    validDirs.push(resolved);
    validFiles.push(traversal.files);
    skippedDirsByFolder.push(traversal.skippedDirs);
  }

  if (validFiles.length < 2) {
    console.error(`${RED}ERROR: Need at least 2 valid directories${RESET}`);
    process.exit(1);
  }

  if (failedArguments > 0) {
    console.error(
      `${RED}ERROR: ${failedArguments} director${failedArguments === 1 ? "y" : "ies"} could not be used; all ${dirs.length} requested folders must be valid${RESET}`,
    );
    process.exit(1);
  }

  const differences = getFolderDifferences(validFiles);
  const commonAll = getCommonFiles(validFiles);
  const contentDifferences = await compareCommonContent(validDirs, commonAll);
  const modifiedPaths = new Set(contentDifferences.map((item) => item.path));
  const identicalPaths = compareContent
    ? [...commonAll].filter((file) => !modifiedPaths.has(file)).sort()
    : [];
  const totalSkipped = skippedDirsByFolder.reduce(
    (total, skipped) => total + skipped.length,
    0,
  );

  if (jsonOutput) {
    const report: JsonReport = {
      schemaVersion: 1,
      contentComparison: compareContent ? "sha256" : "disabled",
      folders: validDirs.map((folder, index) => ({
        path: folder,
        totalFiles: validFiles[index].size,
        skippedDirectories: [...(skippedDirsByFolder[index] ?? [])].sort(),
      })),
      unique: differences.unique.map((files) => [...files].sort()),
      missing: differences.missing.map((files) => [...files].sort()),
      common: [...commonAll].sort(),
      identical: identicalPaths,
      modified: contentDifferences,
      incomplete: totalSkipped > 0,
    };
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(
      differences,
      commonAll,
      contentDifferences,
      identicalPaths.length,
    );
  }

  if (totalSkipped > 0) {
    console.error(
      `${YELLOW}WARNING: Comparison incomplete — ${totalSkipped} director${totalSkipped === 1 ? "y was" : "ies were"} skipped due to read errors${RESET}`,
    );
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(
    `${RED}FATAL: ${err instanceof Error ? err.message : String(err)}${RESET}`,
  );
  process.exit(1);
});
