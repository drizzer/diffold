import { describe, it } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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
    // --allow-write is needed for -f report files.
    return ["deno", ["run", "--allow-read", "--allow-write", "--allow-env", "--allow-sys", cli]];
  }
  if ("Bun" in globalThis) {
    return [process.execPath, ["run", cli]];
  }
  // Node.js — run via the tsx loader (cross-platform; avoids .bin shim/extension issues)
  return [process.execPath, ["--import", "tsx", cli]];
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function runDiffold(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const [cmd, baseArgs] = getRunner();
  // Always spawn from the repo root: the Node runner resolves the `tsx` loader
  // relative to cwd, so a different cwd cannot start the CLI at all.
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
    const result = await runDiffold([FIXTURE_DIR1, FIXTURE_DIR2, "--list"]);

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
    const result = await runDiffold([FIXTURE_DIR1, FIXTURE_DIR2, "--list"]);

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

      const result = await runDiffold([a, b, c, "--list"]);

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

      const result = await runDiffold([empty, other, "--list"]);

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

      const result = await runDiffold([dir, reference, "--list"]);
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

      const result = await runDiffold([dir, dir, "--list"]);
      const output = plain(result.stdout);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(output.includes("Folder 1: 2 total files"));
      assert.ok(output.includes("Unique: 0"));
      assert.ok(output.includes("Missing: 0"));
      assert.deepStrictEqual(listUnder("Unique files:", result.stdout), []);
      assert.ok(output.includes("Common to all 2 folders: 2 files"));
    });
  });

  it("compares common file contents by default", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "content-a", {
        "same.txt": "same bytes",
        "changed.txt": "version a",
        "left.txt": "left only",
      });
      const b = await makeTree(parent, "content-b", {
        "same.txt": "same bytes",
        "changed.txt": "version b",
        "right.txt": "right only",
      });

      const result = await runDiffold([a, b, "--list"]);
      const output = plain(result.stdout);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(output.includes("Common to all 2 folders: 2 files"));
      assert.ok(output.includes("Content: 1 identical | 1 changed"));
      assert.ok(output.includes("changed.txt: Folders 1 != Folders 2"));
      assert.ok(!output.includes("same.txt: Folder"));
    });
  });

  it("groups identical content across three folders", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "groups-a", { "shared.txt": "a" });
      const b = await makeTree(parent, "groups-b", { "shared.txt": "b" });
      const c = await makeTree(parent, "groups-c", { "shared.txt": "a" });

      const result = await runDiffold([a, b, c, "--list"]);
      const output = plain(result.stdout);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(output.includes("Content: 0 identical | 1 changed"));
      assert.ok(output.includes("shared.txt: Folders 1, 3 != Folders 2"));
    });
  });

  it("disables content comparison with -c and --no-content", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "disabled-a", { "shared.txt": "a" });
      const b = await makeTree(parent, "disabled-b", { "shared.txt": "b" });

      for (const flag of ["-c", "--no-content"]) {
        const result = await runDiffold([a, b, flag]);
        const output = plain(result.stdout);

        assert.strictEqual(result.exitCode, 0);
        assert.ok(output.includes("Common to all 2 folders: 1 files"));
        assert.ok(output.includes("Content: comparison disabled (-c)"));
        assert.ok(!output.includes("Content: 0 identical"));
      }
    });
  });



  it("prints one machine-readable JSON report to stdout", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "json-a", {
        "same.txt": "same",
        "changed.txt": "a",
        "only-a.txt": "a",
      });
      const b = await makeTree(parent, "json-b", {
        "same.txt": "same",
        "changed.txt": "b",
        "only-b.txt": "b",
      });

      const result = await runDiffold([a, b, "--json"]);
      const report = JSON.parse(result.stdout);

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stderr, "");
      assert.strictEqual(report.schemaVersion, 1);
      assert.strictEqual(report.contentComparison, "sha256");
      // The CLI resolves each folder through fs.realpath. On Windows that
      // canonicalises an 8.3 short temp path (RUNNER~1) to its long form
      // (runneradmin), while os.tmpdir() may hand the short spelling back.
      // Compare resolved paths so the expectation holds on every platform.
      assert.deepStrictEqual(
        report.folders.map((folder: { path: string }) => folder.path),
        [await realpath(a), await realpath(b)],
      );
      assert.deepStrictEqual(report.unique, [["only-a.txt"], ["only-b.txt"]]);
      assert.deepStrictEqual(report.missing, [["only-b.txt"], ["only-a.txt"]]);
      assert.deepStrictEqual(report.common, ["changed.txt", "same.txt"]);
      assert.deepStrictEqual(report.identical, ["same.txt"]);
      assert.deepStrictEqual(report.modified, [
        { path: "changed.txt", groups: [[0], [1]] },
      ]);
      assert.strictEqual(report.incomplete, false);
      assert.ok(!result.stdout.includes("Folder Diff Report"));
      assert.ok(!result.stdout.includes("\u001b["));
    });
  });

  it("represents disabled content comparison in JSON", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "json-disabled-a", { "shared.txt": "a" });
      const b = await makeTree(parent, "json-disabled-b", { "shared.txt": "b" });

      const result = await runDiffold([a, b, "--json", "-c"]);
      const report = JSON.parse(result.stdout);

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(report.contentComparison, "disabled");
      assert.deepStrictEqual(report.common, ["shared.txt"]);
      assert.deepStrictEqual(report.identical, []);
      assert.deepStrictEqual(report.modified, []);
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

      const result = await runDiffold([...spellings, "--list"]);
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

  it("excludes files and directory subtrees with repeatable glob patterns", async () => {
    await withTempRoot(async (parent) => {
      const layout = {
        "keep.txt": "keep",
        "debug.log": "log",
        "nested/debug.tmp": "tmp",
        "node_modules/package/index.js": "dependency",
        "src/node_modules/also.js": "dependency",
        "build/output.js": "build",
        "build/nested/artifact.txt": "build",
        "src/main.ts": "source",
      };
      const a = await makeTree(parent, "exclude-a", layout);
      const b = await makeTree(parent, "exclude-b", layout);

      const result = await runDiffold([
        a,
        b,
        "--exclude",
        "*.log",
        "--exclude=*.tmp",
        "--exclude",
        "node_modules",
        "--exclude",
        "build/**",
        "--list",
      ], { DIFFOLD_MAX_FILES: "4" });
      const report = JSON.parse((await runDiffold([
        a,
        b,
        "--json",
        "--exclude",
        "*.log",
        "--exclude=*.tmp",
        "--exclude",
        "node_modules",
        "--exclude",
        "build/**",
      ])).stdout);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(plain(result.stdout).includes("Folder 1: 2 total files"));
      assert.deepStrictEqual(report.common, ["keep.txt", "src/main.ts"]);
      assert.ok(!result.stdout.includes("debug.log"));
      assert.ok(!result.stdout.includes("debug.tmp"));
      assert.ok(!result.stdout.includes("node_modules"));
      assert.ok(!result.stdout.includes("build/"));
    });
  });


  it("truncates long lists by default and lists everything with --verbose", async () => {
    await withTempRoot(async (parent) => {
      const layout: Record<string, string> = {};
      for (let index = 0; index < 45; index++) {
        layout[`file-${String(index).padStart(2, "0")}.txt`] = "content";
      }
      const a = await makeTree(parent, "trunc-a", layout);
      const b = await makeTree(parent, "trunc-b", { "only-b.txt": "b" });

      const truncated = plain((await runDiffold([a, b, "--list"])).stdout);
      const verbose = plain((await runDiffold([a, b, "--verbose", "--list"])).stdout);
      const shortFlag = plain((await runDiffold([a, b, "-v", "--list"])).stdout);

      // Folder 1 owns 45 unique files, so only the first 20 are listed.
      assert.ok(truncated.includes("... and 25 more (use --verbose to show all)"));
      assert.ok(!truncated.includes("file-20.txt"));
      // Both folder sections truncate: 45 unique in folder 1, 45 missing in folder 2.
      assert.strictEqual(
        truncated.split("use --verbose to show all").length - 1,
        2,
      );

      assert.ok(!verbose.includes("use --verbose to show all"));
      assert.ok(verbose.includes("file-44.txt"));
      assert.strictEqual(shortFlag, verbose);
    });
  });

  it("truncates the changed-files list by default", async () => {
    await withTempRoot(async (parent) => {
      const aLayout: Record<string, string> = {};
      const bLayout: Record<string, string> = {};
      for (let index = 0; index < 30; index++) {
        const name = `common-${String(index).padStart(2, "0")}.txt`;
        aLayout[name] = "a";
        bLayout[name] = "b";
      }
      const a = await makeTree(parent, "changed-trunc-a", aLayout);
      const b = await makeTree(parent, "changed-trunc-b", bLayout);

      const truncated = plain((await runDiffold([a, b, "--list"])).stdout);
      const verbose = plain((await runDiffold([a, b, "--verbose", "--list"])).stdout);

      assert.ok(truncated.includes("Content: 0 identical | 30 changed"));
      assert.ok(truncated.includes("... and 10 more (use --verbose to show all)"));
      assert.ok(!truncated.includes("common-25.txt"));
      assert.ok(verbose.includes("common-29.txt"));
      assert.ok(!verbose.includes("use --verbose to show all"));
    });
  });

  it("prints only summary counts with --quiet", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "quiet-a", { "shared.txt": "a", "only-a.txt": "a" });
      const b = await makeTree(parent, "quiet-b", { "shared.txt": "b", "only-b.txt": "b" });

      const result = await runDiffold([a, b, "--quiet"]);
      const output = plain(result.stdout);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(output.includes("Folder 1: 2 files, 1 unique, 1 missing"));
      assert.ok(output.includes("Folder 2: 2 files, 1 unique, 1 missing"));
      assert.ok(output.includes("Common to all 2 folders: 1 files"));
      assert.ok(output.includes("Content: 0 identical, 1 changed"));
      assert.ok(output.includes("Totals: 2 unique entries, 2 missing entries"));
      assert.ok(!output.includes("Folder Diff Report"));
      assert.ok(!output.includes("only-a.txt"));
      assert.ok(!output.includes("Supports ~"));
      assert.ok(!result.stdout.includes("\u001b["));
    });
  });

  it("writes a text report file and keeps stdout empty", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "file-a", { "shared.txt": "a", "only-a.txt": "a" });
      const b = await makeTree(parent, "file-b", { "shared.txt": "b", "only-b.txt": "b" });
      const target = path.join(parent, "out", "report");

      const result = await runDiffold([a, b, "-f", target, "--list"]);
      const written = path.join(parent, "out", "report.txt");

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout, "");
      assert.ok(result.stderr.includes("Report saved to"));
      const content = await readFile(written, "utf8");
      assert.ok(content.includes("Folder Diff Report"));
      assert.ok(content.includes("only-a.txt"));
    });
  });

  it("writes a JSON report file with a .json extension", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "file-json-a", { "shared.txt": "a" });
      const b = await makeTree(parent, "file-json-b", { "shared.txt": "b" });
      const target = path.join(parent, "json", "report.json");

      const result = await runDiffold([a, b, "--json", "-f", target]);

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout, "");
      const parsed = JSON.parse(await readFile(target, "utf8"));
      assert.strictEqual(parsed.schemaVersion, 1);
      assert.deepStrictEqual(parsed.modified, [
        { path: "shared.txt", groups: [[0], [1]] },
      ]);
    });
  });

  it("respects an explicit extension instead of appending one", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "file-ext-a", { "shared.txt": "a" });
      const b = await makeTree(parent, "file-ext-b", { "shared.txt": "b" });
      const target = path.join(parent, "custom.data");

      const result = await runDiffold([a, b, "--json", "--file=" + target]);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(await exists(target));
      assert.ok(!(await exists(`${target}.json`)));
    });
  });

  it("refuses to overwrite an existing report file without --force", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "file-clash-a", { "shared.txt": "a" });
      const b = await makeTree(parent, "file-clash-b", { "shared.txt": "b" });
      const target = path.join(parent, "existing.txt");
      await writeFile(target, "do not lose me");

      const blocked = await runDiffold([a, b, "-f", target, "--list"]);
      assert.strictEqual(blocked.exitCode, 2);
      assert.strictEqual(blocked.stdout, "");
      assert.ok(blocked.stderr.includes("Report file already exists"));
      assert.strictEqual(await readFile(target, "utf8"), "do not lose me");

      const forced = await runDiffold([a, b, "-f", target, "--force", "--list"]);
      assert.strictEqual(forced.exitCode, 0);
      assert.ok((await readFile(target, "utf8")).includes("Folder Diff Report"));
    });
  });

  it("does not treat a directory after -f as the output path", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "ambiguous-a", { "shared.txt": "a" });
      const b = await makeTree(parent, "ambiguous-b", { "shared.txt": "b" });

      // Only one directory follows -f, so it must stay a comparison argument and
      // the report falls back to the default file name. The CLI is spawned from
      // the repo root so the tsx loader stays resolvable, so the default file
      // lands there and is cleaned up afterwards.
      const defaultFile = path.join(root, "diffold-report.txt");
      await rm(defaultFile, { force: true });
      let result;
      try {
        result = await runDiffold([a, "-f", b]);
      } finally {
        await rm(defaultFile, { force: true });
      }

      assert.strictEqual(result.exitCode, 0, `stderr was: ${result.stderr}`);
      assert.strictEqual(result.stdout, "");
      assert.ok(result.stderr.includes("diffold-report.txt"));
      // Both directories were compared, so `b` was not swallowed as the path.
      assert.ok(result.stderr.includes("Report saved to"));
    });
  });

  it("rejects combining --verbose and --quiet", async () => {
    const result = await runDiffold([FIXTURE_DIR1, FIXTURE_DIR2, "-v", "-q"]);

    assert.strictEqual(result.exitCode, 2);
    assert.strictEqual(result.stdout, "");
    assert.ok(result.stderr.includes("--verbose and --quiet cannot be combined"));
  });

  it("keeps JSON output complete regardless of verbosity flags", async () => {
    await withTempRoot(async (parent) => {
      const layout: Record<string, string> = {};
      for (let index = 0; index < 30; index++) {
        layout[`file-${String(index).padStart(2, "0")}.txt`] = "content";
      }
      const a = await makeTree(parent, "json-limit-a", layout);
      const b = await makeTree(parent, "json-limit-b", layout);

      const report = JSON.parse((await runDiffold([a, b, "--json"])).stdout);
      const quietReport = JSON.parse((await runDiffold([a, b, "--json", "--quiet"])).stdout);

      assert.strictEqual(report.common.length, 30);
      assert.strictEqual(quietReport.common.length, 30);
      assert.deepStrictEqual(quietReport, report);
    });
  });

  it("exits 1 only with --fail-on-diff when differences exist", async () => {
    await withTempRoot(async (parent) => {
      const same = await makeTree(parent, "gate-same", { "shared.txt": "a" });
      const alsoSame = await makeTree(parent, "gate-also-same", { "shared.txt": "a" });
      const different = await makeTree(parent, "gate-different", { "shared.txt": "b" });

      // Differences present, flag absent: still a success for back-compat.
      const withoutFlag = await runDiffold([same, different, "--list"]);
      assert.strictEqual(withoutFlag.exitCode, 0);
      assert.ok(plain(withoutFlag.stdout).includes("Folder Diff Report"));

      // Differences present with the flag: CI gate fails.
      const withFlag = await runDiffold([same, different, "--fail-on-diff", "--quiet"]);
      assert.strictEqual(withFlag.exitCode, 1);
      assert.ok(plain(withFlag.stdout).includes("Content: 0 identical, 1 changed"));

      // No differences with the flag: success.
      const noDiff = await runDiffold([same, alsoSame, "--fail-on-diff", "--quiet"]);
      assert.strictEqual(noDiff.exitCode, 0);
    });
  });

  it("detects structural-only differences under --fail-on-diff", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "gate-struct-a", { "only-a.txt": "a" });
      const b = await makeTree(parent, "gate-struct-b", { "only-b.txt": "b" });

      const result = await runDiffold([a, b, "--fail-on-diff", "--quiet", "-c"]);
      assert.strictEqual(result.exitCode, 1);
    });
  });

  it("treats an incomplete comparison as fatal rather than a difference", async () => {
    if (process.platform === "win32") return;
    await withTempRoot(async (parent) => {
      const locked = await makeTree(parent, "gate-locked", {
        "visible.txt": "x",
        "restricted/secret.txt": "x",
      });
      const other = await makeTree(parent, "gate-other", { "visible.txt": "x" });

      await chmod(path.join(locked, "restricted"), 0o000);
      try {
        const probe = await runDiffold([locked, locked]);
        if (probe.exitCode === 0) return;

        const result = await runDiffold([locked, other, "--fail-on-diff"]);
        // 2 = fatal/incomplete, never 1 = differences.
        assert.strictEqual(result.exitCode, 2);
        assert.ok(result.stderr.includes("Comparison incomplete"));
      } finally {
        await chmod(path.join(locked, "restricted"), 0o700);
      }
    });
  });

  it("keeps JSON output parseable when --fail-on-diff fails the run", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "gate-json-a", { "shared.txt": "a" });
      const b = await makeTree(parent, "gate-json-b", { "shared.txt": "b" });

      const result = await runDiffold([a, b, "--json", "--fail-on-diff"]);
      const parsed = JSON.parse(result.stdout);

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(parsed.schemaVersion, 1);
      assert.deepStrictEqual(parsed.modified, [
        { path: "shared.txt", groups: [[0], [1]] },
      ]);
    });
  });

  it("requires a pattern for --exclude", async () => {
    const result = await runDiffold([FIXTURE_DIR1, FIXTURE_DIR2, "--exclude"]);

    assert.strictEqual(result.exitCode, 2);
    assert.strictEqual(result.stdout, "");
    assert.ok(result.stderr.includes("--exclude requires a non-empty pattern"));
  });

  it("renders a presence matrix with per-folder cells", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "matrix-a", { "shared.txt": "x", "only-a.txt": "a" });
      const b = await makeTree(parent, "matrix-b", { "shared.txt": "y", "only-b.txt": "b" });
      const c = await makeTree(parent, "matrix-c", { "shared.txt": "x" });

      const result = await runDiffold([a, b, c, "--matrix"]);
      const output = plain(result.stdout);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(output.includes("=== Presence Matrix (3 valid folders) ==="));
      assert.ok(output.includes("File"));
      assert.ok(output.includes("F1"));
      assert.ok(output.includes("F3"));
      // shared.txt is present everywhere, but folder 2 holds the odd variant.
      const sharedRow = output.split("\n").find((line) => line.includes("shared.txt"));
      assert.ok(sharedRow, "shared.txt row missing");
      assert.ok(sharedRow!.includes("Y"));
      assert.ok(sharedRow!.includes("M"));
      assert.ok(output.includes("only-a.txt"));
      assert.ok(output.includes("only-b.txt"));
      assert.ok(output.includes("Legend:"));
      // The matrix replaces the per-folder list sections entirely.
      assert.ok(!output.includes("Unique files:"));
      assert.ok(!output.includes("Missing files:"));
    });
  });

  it("marks a folder as modified only when it is the lone variant", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "matrix-group-a", { "shared.txt": "a" });
      const b = await makeTree(parent, "matrix-group-b", { "shared.txt": "b" });
      const c = await makeTree(parent, "matrix-group-c", { "shared.txt": "a" });

      const result = await runDiffold([a, b, c, "--matrix"]);
      const output = plain(result.stdout);
      const row = output.split("\n").find((line) => line.includes("shared.txt"));

      // Folders 1 and 3 agree, so only folder 2 is flagged.
      const cells = row!.slice(row!.indexOf("shared.txt") + "shared.txt".length);
      assert.strictEqual((cells.match(/M/g) ?? []).length, 1);
    });
  });

  it("truncates matrix rows and honors --verbose", async () => {
    await withTempRoot(async (parent) => {
      const layout: Record<string, string> = {};
      for (let index = 0; index < 30; index++) {
        layout[`entry-${String(index).padStart(2, "0")}.txt`] = "content";
      }
      const a = await makeTree(parent, "matrix-trunc-a", layout);
      // Every row must be notable, otherwise the identical-row hiding added in
      // this release would drop all 30 rows and there would be nothing to truncate.
      const differing = Object.fromEntries(
        Object.keys(layout).map((name) => [name, "different"]),
      );
      const b = await makeTree(parent, "matrix-trunc-b", differing);

      const truncated = plain((await runDiffold([a, b, "--matrix"])).stdout);
      const verbose = plain((await runDiffold([a, b, "--matrix", "--verbose"])).stdout);

      assert.ok(truncated.includes("... and 10 more (use --verbose to show all)"));
      assert.ok(!truncated.includes("entry-25.txt"));
      assert.ok(verbose.includes("entry-29.txt"));
      assert.ok(!verbose.includes("use --verbose to show all"));
    });
  });

  it("suppresses the matrix under --quiet", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "matrix-quiet-a", { "shared.txt": "x" });
      const b = await makeTree(parent, "matrix-quiet-b", { "shared.txt": "y" });

      const result = await runDiffold([a, b, "--matrix", "--quiet"]);
      const output = plain(result.stdout);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(!output.includes("Presence Matrix"));
      assert.ok(!output.includes("Legend:"));
      assert.ok(output.includes("Content: 0 identical, 1 changed"));
    });
  });

  it("expands ~ and reports the expanded path for a missing directory", async () => {
    const missing = "diffold-missing-dir-xyz";
    const result = await runDiffold([`~/${missing}`, "~/diffold-missing-dir-abc"]);

    assert.strictEqual(result.exitCode, 2);
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

    assert.strictEqual(result.exitCode, 2);
    assert.strictEqual(result.stdout, "");
    assert.ok(result.stderr.includes("is not a directory"));
    assert.ok(result.stderr.includes("Need at least 2 valid directories"));
  });

  it("rejects invalid argument counts", async () => {
    const result = await runDiffold([]);

    assert.strictEqual(result.exitCode, 2);
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

    assert.strictEqual(result.exitCode, 2);
    assert.strictEqual(result.stdout, "");
    assert.ok(result.stderr.includes("Usage:"));
    assert.ok(result.stderr.includes("(2-5 directories)"));
  });

  it("rejects missing directories", async () => {
    const result = await runDiffold([FIXTURE_DIR1, "does-not-exist"]);

    assert.strictEqual(result.exitCode, 2);
    assert.strictEqual(result.stdout, "");
    assert.ok(result.stderr.includes("Directory does not exist"));
    assert.ok(result.stderr.includes("Need at least 2 valid directories"));
  });

  it("hints at shell quoting when a Windows path lost its backslashes", async () => {
    const result = await runDiffold([
      "Z:diffold-missing-dir-xyz",
      "Z:diffold-missing-dir-abc",
    ]);

    assert.strictEqual(result.exitCode, 2);
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

      assert.strictEqual(result.exitCode, 2);
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

      assert.strictEqual(result.exitCode, 2);
      assert.strictEqual(result.stdout, "");
      assert.ok(result.stderr.includes("DIFFOLD_MAX_FILES"));
    });
  });

  it("rejects empty and whitespace-only directory arguments before traversal", async () => {
    for (const bad of ["", "   "]) {
      const result = await runDiffold([bad, FIXTURE_DIR2]);

      assert.strictEqual(result.exitCode, 2);
      assert.strictEqual(result.stdout, "");
      assert.ok(result.stderr.includes("empty or whitespace-only"));
    }
  });

  it("preserves significant leading and trailing spaces in directory names", async () => {
    await withTempRoot(async (parent) => {
      const spaced = await makeTree(parent, " spaced ", { "file.txt": "x" });
      const result = await runDiffold([spaced, FIXTURE_DIR1, "--list"]);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes("Folder Diff Report (2 valid folders)"));
      assert.ok(plain(result.stdout).includes("Folder 1: 1 total files"));
    });
  });

  it("does not expand unsupported tilde-user spellings into the home directory", async () => {
    const result = await runDiffold([
      "~nosuchuserxyz/diffold-missing-dir",
      FIXTURE_DIR2,
    ]);

    assert.strictEqual(result.exitCode, 2);
    assert.strictEqual(result.stdout, "");
    // The old bug concatenated the literal name onto the home directory, e.g.
    // `<home>nosuchuserxyz`. Assert on that exact corruption instead of on the
    // home directory itself, which can legitimately appear in resolved paths
    // when the working directory lives under it (as on CI runners).
    assert.ok(
      !result.stderr.includes(`${os.homedir()}nosuchuserxyz`),
      "unsupported ~user must not be concatenated onto the home directory",
    );
    assert.ok(result.stderr.includes("~nosuchuserxyz"));
  });

  it("rejects a comparison when any requested folder is invalid", async () => {
    const result = await runDiffold([
      FIXTURE_DIR1,
      "does-not-exist",
      FIXTURE_DIR2,
    ]);

    assert.strictEqual(result.exitCode, 2);
    assert.strictEqual(result.stdout, "");
    assert.ok(result.stderr.includes("Directory does not exist"));
    assert.ok(result.stderr.includes("all 3 requested folders must be valid"));
  });

  it("compares four folders and keeps only files present everywhere as common", async () => {
    await withTempRoot(async (parent) => {
      const a = await makeTree(parent, "four-a", {
        "shared.txt": "a",
        "only-a.txt": "a",
      });
      const b = await makeTree(parent, "four-b", {
        "shared.txt": "b",
        "only-b.txt": "b",
      });
      const c = await makeTree(parent, "four-c", {
        "shared.txt": "c",
        "only-c.txt": "c",
      });
      const d = await makeTree(parent, "four-d", {
        "shared.txt": "d",
        "only-d.txt": "d",
      });

      const result = await runDiffold([a, b, c, d, "--list"]);
      const output = plain(result.stdout);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(output.includes("Folder Diff Report (4 valid folders)"));
      assert.ok(output.includes("Folder 1: 2 total files"));
      assert.ok(output.includes("Folder 4: 2 total files"));
      assert.ok(output.includes("only-a.txt"));
      assert.ok(output.includes("only-d.txt"));
      assert.ok(output.includes("Common to all 4 folders: 1 files"));
    });
  });

  it("compares five folders and reports per-folder unique files", async () => {
    await withTempRoot(async (parent) => {
      const trees: string[] = [];
      for (let index = 0; index < 5; index++) {
        trees.push(
          await makeTree(parent, `five-${index}`, {
            "shared.txt": `${index}`,
            [`only-${index}.txt`]: `${index}`,
          }),
        );
      }

      const result = await runDiffold([...trees, "--list"]);
      const output = plain(result.stdout);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(output.includes("Folder Diff Report (5 valid folders)"));
      for (let index = 0; index < 5; index++) {
        assert.ok(output.includes(`Folder ${index + 1}: 2 total files`));
        assert.ok(output.includes(`only-${index}.txt`));
      }
      assert.ok(output.includes("Common to all 5 folders: 1 files"));
    });
  });

  it("bounds traversal entries before collecting unbounded file state", async () => {
    await withTempRoot(async (parent) => {
      const broad = path.join(parent, "broad");
      await mkdir(broad, { recursive: true });
      for (let index = 0; index < 4; index++) {
        await writeFile(path.join(broad, `file-${index}.txt`), "x");
      }

      const result = await runDiffold([broad, FIXTURE_DIR1], {
        DIFFOLD_MAX_FILES: "2",
      });

      assert.strictEqual(result.exitCode, 2);
      assert.strictEqual(result.stdout, "");
      assert.ok(result.stderr.includes("DIFFOLD_MAX_FILES"));
    });
  });

  it("reports unreadable subdirectories instead of silently returning success", async () => {
    if (process.platform === "win32") {
      // Windows ACL setup is not portable enough for this repository suite.
      return;
    }
    await withTempRoot(async (parent) => {
      const locked = await makeTree(parent, "locked", {
        "visible.txt": "x",
        "restricted/secret.txt": "x",
      });
      const other = await makeTree(parent, "locked-other", {
        "visible.txt": "x",
      });

      await chmod(path.join(locked, "restricted"), 0o000);
      try {
        const probe = await runDiffold([locked, locked]);
        if (probe.exitCode === 0) {
          // Running as an administrative/root user can still read mode 000.
          return;
        }

        const result = await runDiffold([locked, other]);

        assert.strictEqual(result.exitCode, 2);
        assert.ok(result.stderr.includes("[skip]"));
        assert.ok(result.stderr.includes("Comparison incomplete"));
        assert.ok(plain(result.stdout).includes("[1 directory skipped]"));
      } finally {
        await chmod(path.join(locked, "restricted"), 0o700);
      }
    });
  });

  it("strips ANSI escapes from paths in error messages", async () => {
    const sneaky = path.join(root, "\u001b[31mno-such-dir\u001b[0m");
    const result = await runDiffold([sneaky, FIXTURE_DIR2]);

    assert.strictEqual(result.exitCode, 2);
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

