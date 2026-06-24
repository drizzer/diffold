import { describe, it } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const cli = path.join(root, "index.ts");
const FIXTURE_DIR1 = "tests/test-folders/test_dir1";
const FIXTURE_DIR2 = "tests/test-folders/test_dir2";

function getRunner(): [string, string[]] {
  if (typeof Deno !== "undefined") {
    // --allow-sys is needed for os.homedir() used by ~ expansion.
    return ["deno", ["run", "--allow-read", "--allow-env", "--allow-sys", cli]];
  }
  if ("Bun" in globalThis) {
    return [process.execPath, ["run", cli]];
  }
  // Node.js — run via the tsx loader (cross-platform; avoids .bin shim/extension issues)
  return [process.execPath, ["--import", "tsx", cli]];
}

async function runDiffold(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const [cmd, baseArgs] = getRunner();
  const proc = spawn(cmd, [...baseArgs, ...args], {
    cwd: root,
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const exitCode = await new Promise<number>((resolve) => {
    proc.on("close", (code) => resolve(code ?? 1));
  });

  return {
    stdout: Buffer.concat(stdoutChunks).toString(),
    stderr: Buffer.concat(stderrChunks).toString(),
    exitCode,
  };
}

// Temp trees are built per test and always removed, so the suite leaves nothing
// behind and edge cases (empty dirs, nesting, symlinks) need no committed fixtures.
async function withTempRoot(
  body: (parent: string) => Promise<void>,
): Promise<void> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "diffold-test-"));
  try {
    await body(parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function makeTree(
  parent: string,
  name: string,
  layout: Record<string, string>,
): Promise<string> {
  const dir = path.join(parent, name);
  await mkdir(dir, { recursive: true });
  for (const [relative, content] of Object.entries(layout)) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

// Returns the entries printed under a section heading ("Unique files:" /
// "Missing files:") of the first folder block in the report.
function listUnder(heading: string, stdout: string): string[] {
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return [];

  const entries: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") break;
    if (/^ {2}\S.*:$/.test(line)) break;
    if (/^Folder \d+/.test(trimmed)) break;
    entries.push(trimmed);
  }
  return entries;
}

// Counts are printed with a color escape between the label and the number.
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

function plain(text: string): string {
  return text.replace(ANSI_SGR, "");
}

describe("diffold CLI", () => {
  it("reports unique, missing, and common files for two folders", async () => {
    const result = await runDiffold([FIXTURE_DIR1, FIXTURE_DIR2]);

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stderr, "");
    assert.ok(result.stdout.includes("Folder Diff Report (2 valid folders)"));
    assert.ok(result.stdout.includes("Folder 1: 4 total files"));
    assert.ok(result.stdout.includes("Folder 2: 3 total files"));
    assert.ok(result.stdout.includes("file1.txt"));
    assert.ok(result.stdout.includes("unique1.txt"));
    assert.ok(result.stdout.includes("unique2.txt"));
    assert.ok(result.stdout.includes("Common to all 2 folders:"));
  });

  it("keeps common files out of the unique and missing lists", async () => {
    const result = await runDiffold([FIXTURE_DIR1, FIXTURE_DIR2]);

    const unique = listUnder("Unique files:", result.stdout).sort();
    const missing = listUnder("Missing files:", result.stdout);

    assert.deepStrictEqual(unique, ["file1.txt", "unique1.txt"]);
    assert.deepStrictEqual(missing, ["unique2.txt"]);
    // file.txt and shared.txt exist in both folders, so neither list may claim them.
    for (const common of ["file.txt", "shared.txt"]) {
      assert.ok(!unique.includes(common), `${common} must not be unique`);
      assert.ok(!missing.includes(common), `${common} must not be missing`);
    }
    assert.ok(plain(result.stdout).includes("Common to all 2 folders: 2 files"));
  });

  it("compares three folders and recurses into nested directories", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "a", {
        "top.txt": "a",
        "sub/nested.txt": "a",
        "sub/deep/deeper.txt": "a",
      });
      const b = await makeTree(parent, "b", { "top.txt": "b" });
      const c = await makeTree(parent, "c", {
        "top.txt": "c",
        "only-c.txt": "c",
      });

      const result = await runDiffold([a, b, c]);

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stderr, "");
      assert.ok(result.stdout.includes("Folder Diff Report (3 valid folders)"));
      assert.ok(result.stdout.includes("Folder 1: 3 total files"));
      assert.ok(result.stdout.includes("Folder 2: 1 total files"));
      assert.ok(result.stdout.includes("Folder 3: 2 total files"));
      // Nested entries are reported as forward-slash relative paths.
      assert.ok(result.stdout.includes("sub/nested.txt"));
      assert.ok(result.stdout.includes("sub/deep/deeper.txt"));
      assert.ok(plain(result.stdout).includes("Common to all 3 folders: 1 files"));
    });
  });

  it("treats an empty directory as a valid folder", async () => {
    await withTempRoot(async (parent) => {
      const empty = await makeTree(parent, "empty", {});
      const other = await makeTree(parent, "other", { "file.txt": "x" });

      const result = await runDiffold([empty, other]);

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stderr, "");
      assert.ok(result.stdout.includes("Folder Diff Report (2 valid folders)"));
      assert.ok(result.stdout.includes("Folder 1: 0 total files"));
    });
  });

  it("skips symbolic links instead of following them", async () => {
    await withTempRoot(async (parent) => {
      const dir = path.join(parent, "linked");
      await mkdir(path.join(dir, "target"), { recursive: true });
      await writeFile(path.join(dir, "target", "inner.txt"), "x");
      await writeFile(path.join(dir, "plain.txt"), "x");

      try {
        await symlink(
          path.join(dir, "target"),
          path.join(dir, "link-dir"),
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch {
        // Creating links can need privileges; where that fails the linked-tree
        // assertion is skipped (CI on Linux covers it).
        return;
      }

      const reference = await makeTree(parent, "reference", {
        "target/inner.txt": "x",
        "plain.txt": "x",
      });

      const result = await runDiffold([dir, reference]);
      const output = plain(result.stdout);

      assert.strictEqual(result.exitCode, 0);
      // The linked tree is ignored: only target/ + plain.txt are counted.
      assert.ok(output.includes("Folder 1: 2 total files"));
      assert.ok(!output.includes("link-dir/"));
      assert.ok(output.includes("Unique: 0"));
      assert.ok(output.includes("Common to all 2 folders: 2 files"));
    });
  });

  it("reports no differences when the same directory is passed twice", async () => {
    await withTempRoot(async (parent) => {
      const dir = await makeTree(parent, "same", {
        "a.txt": "a",
        "sub/b.txt": "b",
      });

      const result = await runDiffold([dir, dir]);
      const output = plain(result.stdout);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(output.includes("Folder 1: 2 total files"));
      assert.ok(output.includes("Unique: 0"));
      assert.ok(output.includes("Missing: 0"));
      assert.deepStrictEqual(listUnder("Unique files:", result.stdout), []);
      assert.ok(output.includes("Common to all 2 folders: 2 files"));
    });
  });

  it("resolves equivalent path spellings to the same directory", async () => {
    await withTempRoot(async (parent) => {
      const dir = await makeTree(parent, "norm", {
        "a.txt": "a",
        "sub/b.txt": "b",
      });
      const forwardSlashes = dir.replace(/\\/g, "/");
      const spellings = [dir, forwardSlashes];
      if (process.platform === "win32") {
        // Same path with a lower-case drive letter.
        spellings.push(forwardSlashes.replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase()));
      }

      const result = await runDiffold(spellings);
      const output = plain(result.stdout);

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stderr, "");
      assert.ok(output.includes("Unique: 0"));
      assert.ok(output.includes("Missing: 0"));
      assert.ok(
        output.includes(`Common to all ${spellings.length} folders: 2 files`),
      );
    });
  });

  it("expands ~ and reports the expanded path for a missing directory", async () => {
    const missing = "diffold-missing-dir-xyz";
    const result = await runDiffold([`~/${missing}`, "~/diffold-missing-dir-abc"]);

    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.stdout, "");
    const expanded = path.resolve(os.homedir(), missing);
    assert.ok(
      result.stderr.includes(expanded),
      `expected expanded path ${expanded} in stderr, got: ${result.stderr}`,
    );
    assert.ok(!result.stderr.includes(`~/${missing}`));
    assert.ok(result.stderr.includes("Need at least 2 valid directories"));
  });

  it("rejects a file passed as a folder argument", async () => {
    const result = await runDiffold(["index.ts", FIXTURE_DIR2]);

    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.stdout, "");
    assert.ok(result.stderr.includes("is not a directory"));
    assert.ok(result.stderr.includes("Need at least 2 valid directories"));
  });

  it("rejects invalid argument counts", async () => {
    const result = await runDiffold([]);

    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.stdout, "");
    assert.ok(result.stderr.includes("Usage:"));
    assert.ok(result.stderr.includes("diffold <dir1>"));
    assert.ok(!result.stderr.includes("index.ts <dir1>"));
  });

  it("rejects more than five folders", async () => {
    const result = await runDiffold([
      FIXTURE_DIR1,
      FIXTURE_DIR2,
      FIXTURE_DIR1,
      FIXTURE_DIR2,
      FIXTURE_DIR1,
      FIXTURE_DIR2,
    ]);

    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.stdout, "");
    assert.ok(result.stderr.includes("Usage:"));
    assert.ok(result.stderr.includes("(2-5 directories)"));
  });

  it("rejects missing directories", async () => {
    const result = await runDiffold([FIXTURE_DIR1, "does-not-exist"]);

    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.stdout, "");
    assert.ok(result.stderr.includes("Directory does not exist"));
    assert.ok(result.stderr.includes("Need at least 2 valid directories"));
  });

  it("hints at shell quoting when a Windows path lost its backslashes", async () => {
    const result = await runDiffold([
      "Z:diffold-missing-dir-xyz",
      "Z:diffold-missing-dir-abc",
    ]);

    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.stdout, "");
    assert.ok(result.stderr.includes("Directory does not exist"));
    assert.ok(result.stderr.includes("HINT:"));
    assert.ok(result.stderr.includes("forward slashes"));
  });

  it("enforces the traversal depth limit", async () => {
    await withTempRoot(async (parent) => {
      const deep = await makeTree(parent, "deep", { "l1/l2/l3/leaf.txt": "x" });

      const result = await runDiffold([deep, FIXTURE_DIR1], {
        DIFFOLD_MAX_DEPTH: "2",
      });

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(result.stdout, "");
      assert.ok(result.stderr.includes("DIFFOLD_MAX_DEPTH"));
    });
  });

  it("enforces the file count limit", async () => {
    await withTempRoot(async (parent) => {
      const many = await makeTree(parent, "many", { "a.txt": "a", "b.txt": "b" });

      const result = await runDiffold([many, FIXTURE_DIR1], {
        DIFFOLD_MAX_FILES: "1",
      });

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(result.stdout, "");
      assert.ok(result.stderr.includes("DIFFOLD_MAX_FILES"));
    });
  });

  it("strips ANSI escapes from paths in error messages", async () => {
    const sneaky = path.join(root, "\u001b[31mno-such-dir\u001b[0m");
    const result = await runDiffold([sneaky, FIXTURE_DIR2]);

    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.stdout, "");
    assert.ok(result.stderr.includes("no-such-dir"));
    assert.ok(
      !result.stderr.includes("\u001b[31mno-such-dir"),
      "an ANSI sequence from an argument must not reach stderr",
    );
  });

  it("strips ANSI escapes from file names before printing", async () => {
    await withTempRoot(async (parent) => {
      const evil = "\u001b[31mevil\u001b[0m.txt";
      let dir: string;
      try {
        dir = await makeTree(parent, "ansi", { [evil]: "x", "plain.txt": "x" });
      } catch {
        // Some filesystems reject control characters in file names.
        return;
      }

      const result = await runDiffold([dir, FIXTURE_DIR1]);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes("evil.txt"));
      assert.ok(
        !result.stdout.includes("\u001b[31mevil"),
        "an ANSI sequence from a file name must not reach stdout",
      );
    });
  });
});

