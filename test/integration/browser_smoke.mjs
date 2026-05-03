/* global WebSocket */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import baseSuiVersion from "../../sui-version.json" with { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const sourceDir = path.join(repoRoot, ".sui-build/source");
const modeArg = process.argv[2] || process.env.SUI_BROWSER_MODE || "lite";
if (modeArg !== "full" && modeArg !== "lite") {
  throw new Error(
    `Browser smoke mode must be 'full' or 'lite', got: ${modeArg}`
  );
}
const mode = modeArg;
const packageSubdir = process.env.SUI_BROWSER_PACKAGE || "examples/move/token";
const browserBin =
  process.env.BROWSER_BIN ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browserTimeoutMs = Number(process.env.SUI_BROWSER_TIMEOUT_MS || 180000);
const suiRepoUrl = "https://github.com/MystenLabs/sui.git";
const suiCommit = baseSuiVersion.commit;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
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

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
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

      if (
        entry.name.endsWith(".move") ||
        entry.name.endsWith(".toml") ||
        entry.name.endsWith(".lock")
      ) {
        const fullPath = path.join(currentDir, entry.name);
        const relativePath = path
          .relative(baseDir, fullPath)
          .replace(/\\/g, "/");
        files[relativePath] = await fs.readFile(fullPath, "utf8");
      }
    }
  }

  await visit(packageDir, packageDir);
  return files;
}

function safePathUnder(baseDir, requestedPath) {
  const fullPath = path.resolve(baseDir, requestedPath);
  const relativePath = path.relative(baseDir, fullPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Path escapes base directory: ${requestedPath}`);
  }
  return fullPath;
}

function html() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>RUNNING</title>
  </head>
  <body>
    <pre id="out">running</pre>
    <script type="module">
      import {
        initMovePackageBuilder,
        getPinnedSuiVersion,
        dumpMovePackage,
      } from "/dist/${mode}/index.js";

      const out = document.getElementById("out");
      const suiCommit = ${JSON.stringify(suiCommit)};
      const packageSubdir = ${JSON.stringify(packageSubdir)};

      async function readPackage(subdir) {
        const response = await fetch("/package?subdir=" + encodeURIComponent(subdir));
        if (!response.ok) {
          throw new Error(await response.text());
        }
        return response.json();
      }

      const fetcher = {
        async fetch(gitUrl, rev, subdir = "") {
          if (!gitUrl.includes("github.com/MystenLabs/sui")) {
            throw new Error("Unexpected git dependency: " + gitUrl);
          }
          if (rev !== suiCommit && !suiCommit.startsWith(rev)) {
            throw new Error("Unexpected Sui rev: " + rev);
          }
          return readPackage(subdir);
        },
        async fetchFile(gitUrl, rev, filePath) {
          if (!gitUrl.includes("github.com/MystenLabs/sui")) {
            return null;
          }
          const response = await fetch("/file?path=" + encodeURIComponent(filePath));
          return response.ok ? response.text() : null;
        },
        getResolvedSha(gitUrl, rev) {
          if (gitUrl.includes("github.com/MystenLabs/sui")) {
            return suiCommit;
          }
          return undefined;
        },
      };

      try {
        await initMovePackageBuilder();
        const version = await getPinnedSuiVersion();
        const files = await readPackage(packageSubdir);
        const result = await dumpMovePackage({
          files,
          fetcher,
          rootGit: {
            git: ${JSON.stringify(suiRepoUrl)},
            rev: suiCommit,
            subdir: packageSubdir,
          },
          network: "mainnet",
          silenceWarnings: true,
        });

        if ("error" in result) {
          throw new Error(result.error);
        }

        document.body.dataset.status = "pass";
        document.title = "PASS";
        out.textContent = JSON.stringify({
          status: "pass",
          version,
          modules: result.modules.length,
          dependencies: result.dependencies.length,
        });
      } catch (error) {
        document.body.dataset.status = "fail";
        document.title = "FAIL";
        out.textContent = error && error.stack ? error.stack : String(error);
      }
    </script>
  </body>
</html>`;
}

async function serveRequest(req, res) {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": contentTypes[".html"] });
      res.end(html());
      return;
    }

    if (url.pathname === "/package") {
      const subdir = url.searchParams.get("subdir") || "";
      const packageDir = safePathUnder(sourceDir, subdir);
      const files = await readMovePackageFiles(packageDir);
      res.writeHead(200, { "Content-Type": contentTypes[".json"] });
      res.end(JSON.stringify(files));
      return;
    }

    if (url.pathname === "/file") {
      const requestedPath = url.searchParams.get("path") || "";
      const filePath = safePathUnder(sourceDir, requestedPath);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(await fs.readFile(filePath, "utf8"));
      return;
    }

    const staticPath = safePathUnder(repoRoot, url.pathname.slice(1));
    const content = await fs.readFile(staticPath);
    res.writeHead(200, {
      "Content-Type":
        contentTypes[path.extname(staticPath)] || "application/octet-stream",
    });
    res.end(content);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(error instanceof Error ? error.stack : String(error));
  }
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
  });
}

async function waitForFile(filePath, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      await delay(50);
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForChromeExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(timeoutMs),
  ]);
}

async function stopChrome(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await waitForChromeExit(child, 2000);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForChromeExit(child, 2000);
  }
}

function appendLimited(buffer, chunk) {
  const next = buffer + chunk.toString();
  return next.length > 20000 ? next.slice(-20000) : next;
}

async function launchChrome(userDataDir) {
  const child = spawn(
    browserBin,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-sync",
      "--no-first-run",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = appendLimited(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendLimited(stderr, chunk);
  });

  child.once("error", (error) => {
    stderr = appendLimited(stderr, error.stack || error.message);
  });

  const devToolsFile = path.join(userDataDir, "DevToolsActivePort");
  const devToolsInfo = await waitForFile(devToolsFile, 10000);
  const [port] = devToolsInfo.trim().split(/\r?\n/);
  if (!port) {
    throw new Error(`Chrome did not report a DevTools port.\n${stderr}`);
  }

  return {
    child,
    debugBaseUrl: `http://127.0.0.1:${port}`,
    getOutput: () => ({ stdout, stderr }),
  };
}

async function openPage(debugBaseUrl, url) {
  const endpoint = `${debugBaseUrl}/json/new?${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, { method: "PUT" });
  if (!response.ok) {
    throw new Error(
      `Failed to open browser page: ${response.status} ${await response.text()}`
    );
  }
  const target = await response.json();
  if (!target.webSocketDebuggerUrl) {
    throw new Error("Chrome did not return a page WebSocket URL.");
  }
  return target.webSocketDebuggerUrl;
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) {
      return;
    }

    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(message.error.message || JSON.stringify(message.error)));
    } else {
      resolve(message.result);
    }
  });

  socket.addEventListener("close", () => {
    for (const { reject } of pending.values()) {
      reject(new Error("Chrome DevTools connection closed."));
    }
    pending.clear();
  });

  function send(method, params = {}) {
    const id = nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(payload);
    });
  }

  return {
    send,
    close: () => socket.close(),
  };
}

async function readBrowserStatus(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => ({
      status: document.body?.dataset?.status || "",
      title: document.title,
      output: document.getElementById("out")?.textContent || ""
    }))()`,
    returnByValue: true,
    awaitPromise: true,
  });

  return result.result?.value || { status: "", title: "", output: "" };
}

async function waitForBrowserPass(cdp) {
  const startedAt = Date.now();
  let lastStatus = { status: "", title: "", output: "" };

  while (Date.now() - startedAt < browserTimeoutMs) {
    lastStatus = await readBrowserStatus(cdp);
    if (lastStatus.status === "pass") {
      return lastStatus;
    }
    if (lastStatus.status === "fail") {
      throw new Error(`Browser smoke test failed:\n${lastStatus.output}`);
    }
    await delay(250);
  }

  throw new Error(
    `Timed out waiting for browser smoke test to finish.\nLast output:\n${lastStatus.output}`
  );
}

if (!(await pathExists(browserBin))) {
  throw new Error(
    `Browser binary not found: ${browserBin}. Set BROWSER_BIN to a Chromium-compatible browser.`
  );
}
if (!(await pathExists(path.join(sourceDir, packageSubdir, "Move.toml")))) {
  throw new Error(
    `Missing Sui source package at ${path.join(sourceDir, packageSubdir)}. Run npm run build:wasm or a parity test first.`
  );
}

const server = createServer((req, res) => {
  void serveRequest(req, res);
});
const userDataDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "sui-browser-smoke-")
);

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const testUrl = `http://127.0.0.1:${port}/`;

let chrome;
let cdp;

try {
  chrome = await launchChrome(userDataDir);
  const webSocketUrl = await openPage(chrome.debugBaseUrl, testUrl);
  cdp = await connectCdp(webSocketUrl);
  await cdp.send("Runtime.enable");

  const status = await waitForBrowserPass(cdp);
  console.log(`[OK] browser ${mode}: ${status.output || "pass"}`);
} catch (error) {
  const chromeOutput = chrome?.getOutput?.();
  const detail = [
    error instanceof Error ? error.stack || error.message : String(error),
    chromeOutput?.stderr,
    chromeOutput?.stdout,
  ]
    .filter(Boolean)
    .join("\n");
  throw new Error(detail);
} finally {
  cdp?.close();
  if (chrome?.child) {
    await stopChrome(chrome.child);
  }
  await closeServer(server);
  await fs.rm(userDataDir, { recursive: true, force: true });
}
