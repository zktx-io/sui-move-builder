import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import baseSuiVersion from "../sui-version.json" with { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(repoRoot, ".sui-build/source");
const gitCacheDir = path.join(repoRoot, ".sui-build/browser-parity-git");
const port = Number(process.env.BROWSER_PARITY_PORT || 4174);
const suiCli = process.env.SUI_CLI || "sui";
const suiRepoUrl = "https://github.com/MystenLabs/sui.git";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function isIgnoredDir(name) {
  return (
    name === ".git" ||
    name === "build" ||
    name === "target" ||
    name === "node_modules"
  );
}

function isPackageFile(name) {
  return (
    name.endsWith(".move") || name.endsWith(".toml") || name.endsWith(".lock")
  );
}

function isInsideDir(child, parent) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (Boolean(relative) &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative))
  );
}

function safePathUnder(baseDir, requestedPath = "") {
  const fullPath = path.resolve(baseDir, requestedPath);
  if (!isInsideDir(fullPath, baseDir)) {
    throw new Error(`Path escapes base directory: ${requestedPath}`);
  }
  return fullPath;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": contentTypes[".json"],
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sendError(res, error) {
  sendJson(res, 500, {
    error: error instanceof Error ? error.message : String(error),
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} failed`,
        result.stderr?.trim(),
        result.stdout?.trim(),
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  return result.stdout;
}

function normalizeGitUrl(gitUrl) {
  if (!gitUrl || typeof gitUrl !== "string") {
    throw new Error("Missing gitUrl");
  }
  if (/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(\.git)?$/i.test(gitUrl)) {
    return gitUrl.endsWith(".git") ? gitUrl : `${gitUrl}.git`;
  }
  if (/^git@github\.com:[^/\s]+\/[^/\s]+(\.git)?$/i.test(gitUrl)) {
    return gitUrl.endsWith(".git") ? gitUrl : `${gitUrl}.git`;
  }
  throw new Error(`Only GitHub git URLs are supported: ${gitUrl}`);
}

function isPinnedSuiRepo(gitUrl, rev) {
  const normalized = normalizeGitUrl(gitUrl).toLowerCase();
  const isSui =
    normalized === "https://github.com/mystenlabs/sui.git" ||
    normalized === "git@github.com:mystenlabs/sui.git";
  return (
    isSui &&
    (!rev ||
      rev === baseSuiVersion.commit ||
      baseSuiVersion.commit.startsWith(rev))
  );
}

async function readMovePackageFiles(packageDir) {
  const files = {};

  async function visit(currentDir, baseDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!isIgnoredDir(entry.name)) {
          await visit(path.join(currentDir, entry.name), baseDir);
        }
        continue;
      }

      if (!isPackageFile(entry.name)) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
      files[relativePath] = await fs.readFile(fullPath, "utf8");
    }
  }

  await visit(packageDir, packageDir);
  return files;
}

async function countMoveFiles(packageDir) {
  let count = 0;

  async function visit(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!isIgnoredDir(entry.name)) {
          await visit(path.join(currentDir, entry.name));
        }
      } else if (entry.name.endsWith(".move")) {
        count += 1;
      }
    }
  }

  await visit(packageDir);
  return count;
}

async function discoverExamples() {
  const examplesDir = path.join(sourceDir, "examples/move");
  if (!(await pathExists(examplesDir))) {
    return [];
  }

  const packages = [];
  async function visit(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "Move.toml")) {
      packages.push({
        subdir: path.relative(sourceDir, currentDir).replace(/\\/g, "/"),
        moveFiles: await countMoveFiles(currentDir),
      });
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !isIgnoredDir(entry.name)) {
        await visit(path.join(currentDir, entry.name));
      }
    }
  }

  await visit(examplesDir);
  return packages.sort(
    (a, b) => b.moveFiles - a.moveFiles || a.subdir.localeCompare(b.subdir)
  );
}

async function ensureGitCheckout(gitUrl, rev = "HEAD") {
  const normalizedGitUrl = normalizeGitUrl(gitUrl);
  const cacheKey = createHash("sha256")
    .update(`${normalizedGitUrl}\n${rev}`)
    .digest("hex")
    .slice(0, 16);
  const checkoutDir = path.join(gitCacheDir, cacheKey);

  if (await pathExists(path.join(checkoutDir, ".git"))) {
    const resolvedCommit = run("git", ["rev-parse", "HEAD"], {
      cwd: checkoutDir,
    }).trim();
    return { checkoutDir, resolvedCommit };
  }

  await fs.rm(checkoutDir, { recursive: true, force: true });
  await fs.mkdir(checkoutDir, { recursive: true });
  run("git", ["init"], { cwd: checkoutDir });
  run("git", ["remote", "add", "origin", normalizedGitUrl], {
    cwd: checkoutDir,
  });

  try {
    run("git", ["fetch", "--depth", "1", "origin", rev], {
      cwd: checkoutDir,
    });
  } catch (firstError) {
    try {
      run("git", ["fetch", "--depth", "1", "origin", `refs/tags/${rev}`], {
        cwd: checkoutDir,
      });
    } catch {
      throw firstError;
    }
  }

  run("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: checkoutDir });
  const resolvedCommit = run("git", ["rev-parse", "HEAD"], {
    cwd: checkoutDir,
  }).trim();
  return { checkoutDir, resolvedCommit };
}

async function resolveGitPackage(gitUrl, rev, subdir = "") {
  if (isPinnedSuiRepo(gitUrl, rev) && (await pathExists(sourceDir))) {
    return {
      packageDir: safePathUnder(sourceDir, subdir),
      rootGit: {
        git: suiRepoUrl,
        rev: baseSuiVersion.commit,
        subdir,
      },
      resolvedCommit: baseSuiVersion.commit,
    };
  }

  const { checkoutDir, resolvedCommit } = await ensureGitCheckout(gitUrl, rev);
  return {
    packageDir: safePathUnder(checkoutDir, subdir),
    rootGit: {
      git: normalizeGitUrl(gitUrl),
      rev: resolvedCommit,
      subdir,
    },
    resolvedCommit,
  };
}

async function resolvePackageDescriptor(input) {
  const source = input.source || "sui-example";

  if (source === "sui-example") {
    const subdir = input.subdir || "examples/move/token";
    return {
      source,
      packageDir: safePathUnder(sourceDir, subdir),
      rootGit: {
        git: suiRepoUrl,
        rev: baseSuiVersion.commit,
        subdir,
      },
    };
  }

  if (source === "local") {
    if (!input.path) {
      throw new Error("Missing local package path");
    }
    return {
      source,
      packageDir: path.resolve(String(input.path)),
      rootGit: undefined,
    };
  }

  if (source === "git") {
    const resolved = await resolveGitPackage(
      input.gitUrl,
      input.rev || "HEAD",
      input.subdir || ""
    );
    return { source, ...resolved };
  }

  throw new Error(`Unsupported source: ${source}`);
}

async function assertMovePackage(packageDir) {
  if (!(await pathExists(path.join(packageDir, "Move.toml")))) {
    throw new Error(`Move.toml not found in ${packageDir}`);
  }
}

function parseCliBuildOutput(stdout, packageDir) {
  const jsonStart = stdout.indexOf("{");
  const jsonEnd = stdout.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    throw new Error(`Sui CLI did not emit JSON output for ${packageDir}`);
  }
  return JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
}

async function loadPackage(input) {
  const descriptor = await resolvePackageDescriptor(input);
  await assertMovePackage(descriptor.packageDir);
  const files = await readMovePackageFiles(descriptor.packageDir);
  return {
    files,
    rootGit: descriptor.rootGit,
    packageDir: descriptor.packageDir,
    source: descriptor.source,
    fileCount: Object.keys(files).length,
  };
}

async function runCliBuild(input) {
  const descriptor = await resolvePackageDescriptor(input);
  await assertMovePackage(descriptor.packageDir);
  const version = run(suiCli, ["--version"]).trim();
  const stdout = run(
    suiCli,
    [
      "move",
      "build",
      "--dump-bytecode-as-base64",
      "--path",
      descriptor.packageDir,
    ],
    { cwd: repoRoot }
  );
  return {
    version,
    output: parseCliBuildOutput(stdout, descriptor.packageDir),
    packageDir: descriptor.packageDir,
  };
}

async function readGitFile(input) {
  const { packageDir } = await resolveGitPackage(
    input.gitUrl,
    input.rev || "HEAD",
    ""
  );
  const filePath = safePathUnder(packageDir, input.filePath || "");
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      suiVersion: baseSuiVersion.version,
      suiCommit: baseSuiVersion.commit,
      examples: await discoverExamples(),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/load-package") {
    sendJson(res, 200, await loadPackage(await readJson(req)));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cli-build") {
    sendJson(res, 200, await runCliBuild(await readJson(req)));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/git-package") {
    const input = await readJson(req);
    const { packageDir, rootGit } = await resolveGitPackage(
      input.gitUrl,
      input.rev || "HEAD",
      input.subdir || ""
    );
    await assertMovePackage(packageDir);
    sendJson(res, 200, {
      files: await readMovePackageFiles(packageDir),
      rootGit,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/git-file") {
    sendJson(res, 200, { content: await readGitFile(await readJson(req)) });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(res, url) {
  const requestPath =
    url.pathname === "/" ? "test/browser-parity.html" : url.pathname.slice(1);
  const filePath = safePathUnder(repoRoot, requestPath);
  const content = await fs.readFile(filePath);
  res.writeHead(200, {
    "Content-Type":
      contentTypes[path.extname(filePath)] || "application/octet-stream",
  });
  res.end(content);
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
      } else {
        await serveStatic(res, url);
      }
    } catch (error) {
      sendError(res, error);
    }
  })();
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;
  console.log(`Browser parity page: http://127.0.0.1:${actualPort}/`);
});
