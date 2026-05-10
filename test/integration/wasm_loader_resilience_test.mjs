import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const verificationDist = path.join(repoRoot, "dist", "verification");
const currentWasmPath = path.join(verificationDist, "sui_move_wasm_bg.wasm");
const browserBin =
  process.env.BROWSER_BIN ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browserTimeoutMs = Number(process.env.SUI_BROWSER_TIMEOUT_MS || 180000);
const retryQueryParam = "sui_move_builder_retry";

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function fakeV6Module() {
  return Buffer.from([0xa1, 0x1c, 0xeb, 0x0b, 6, 0, 0, 0]).toString("base64");
}

function fixtureFiles() {
  return {
    "Move.toml": `
[package]
name = "LoaderFixture"
version = "0.0.0"
edition = "2024"

[addresses]
loader_fixture = "0x0"
`,
    "sources/main.move": `
module loader_fixture::main {
    public fun value(): u64 { 1 }
}
`,
  };
}

function childInitScript() {
  return `
const mod = await import(new URL("./dist/verification/index.js", "file://${repoRoot.replace(/\\/g, "/")}/"));
try {
  await mod.initMovePackageVerifier({ wasm: process.argv[1] });
  process.exit(0);
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
`;
}

function childRecoveryScript() {
  return `
const mod = await import(new URL("./dist/verification/index.js", "file://${repoRoot.replace(/\\/g, "/")}/"));
let failed = false;
try {
  await mod.initMovePackageVerifier({ wasm: process.argv[1] });
} catch {
  failed = true;
}
if (!failed) {
  console.error("first init unexpectedly succeeded");
  process.exit(1);
}
try {
  await mod.initMovePackageVerifier({ wasm: process.argv[2] });
  process.exit(0);
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
`;
}

async function runNodeScript(script, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script, ...args],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("child script timed out"));
    }, 60000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (status, signal) => {
      clearTimeout(timeout);
      resolve({
        status,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

async function withServer(handler, run) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.unref();
  try {
    const { port } = server.address();
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => {
      server.close(resolve);
    });
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
    server.unref();
  }
}

function responseText(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

async function runCurrentWasmRetryChecks() {
  const wasm = await fs.readFile(currentWasmPath);

  let transientHits = 0;
  await withServer(async (req, res) => {
    if (req.url === "/current.wasm") {
      transientHits += 1;
      if (transientHits === 1) {
        responseText(res, 503, "warming");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/wasm" });
      res.end(wasm);
      return;
    }
    responseText(res, 404, "missing");
  }, async (baseUrl) => {
    const result = await runNodeScript(childInitScript(), [
      `${baseUrl}/current.wasm`,
    ]);
    if (result.status !== 0) {
      throw new Error(`current WASM transient retry failed:\n${result.stderr}`);
    }
    if (transientHits !== 2) {
      throw new Error(`expected 2 current WASM requests, got ${transientHits}`);
    }
  });

  let missingHits = 0;
  await withServer(async (req, res) => {
    if (req.url === "/missing.wasm") {
      missingHits += 1;
      responseText(res, 404, "missing");
      return;
    }
    responseText(res, 404, "missing");
  }, async (baseUrl) => {
    const result = await runNodeScript(childInitScript(), [
      `${baseUrl}/missing.wasm`,
    ]);
    if (result.status === 0) {
      throw new Error("current WASM 404 unexpectedly succeeded");
    }
    if (missingHits !== 1) {
      throw new Error(`expected no retry for current WASM 404, got ${missingHits}`);
    }
  });

  let failHits = 0;
  let successHits = 0;
  await withServer(async (req, res) => {
    if (req.url === "/fail.wasm") {
      failHits += 1;
      responseText(res, 503, "still warming");
      return;
    }
    if (req.url === "/success.wasm") {
      successHits += 1;
      res.writeHead(200, { "Content-Type": "application/wasm" });
      res.end(wasm);
      return;
    }
    responseText(res, 404, "missing");
  }, async (baseUrl) => {
    const result = await runNodeScript(childRecoveryScript(), [
      `${baseUrl}/fail.wasm`,
      `${baseUrl}/success.wasm`,
    ]);
    if (result.status !== 0) {
      throw new Error(`current WASM rejected cache recovery failed:\n${result.stderr}`);
    }
    if (failHits !== 3 || successHits !== 1) {
      throw new Error(
        `unexpected recovery request counts: fail=${failHits}, success=${successHits}`
      );
    }
  });
}

function browserHtml({ verifierAssetBaseUrl = "/assets", customWasm = false }) {
  return `<!doctype html>
<html>
  <body>
    <script type="module">
      import { verifyMovePackageProvenance } from "/dist/verification/index.js";
      const files = ${JSON.stringify(fixtureFiles())};
      const input = {
        files,
        resolvedDependencies: {
          files: JSON.stringify(files),
          dependencies: "[]",
          lockfileDependencies: "[]"
        },
        intent: "publish",
        reference: {
          modules: [${JSON.stringify(fakeV6Module())}],
          dependencies: []
        },
        silenceWarnings: true,
        verifierAssetBaseUrl: ${JSON.stringify(verifierAssetBaseUrl)}
      };
      if (${customWasm ? "true" : "false"}) {
        input.wasm = new URL("/custom/current.wasm", location.href);
      }
      const result = await verifyMovePackageProvenance(input);
      await fetch("/__result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result)
      });
    </script>
  </body>
</html>`;
}

function serveStaticFile(res, fullPath, contentType) {
  return fs.readFile(fullPath).then(
    (content) => {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    },
    () => responseText(res, 404, "missing")
  );
}

function routeDistPath(urlPath) {
  const relative = urlPath.replace(/^\/dist\/verification\/?/, "");
  return path.join(verificationDist, relative);
}

function routeAssetPath(urlPath) {
  const relative = urlPath.replace(/^\/assets\/?/, "");
  return path.join(verificationDist, relative);
}

async function launchBrowser(url) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sui-loader-browser-"));
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
      url,
    ],
    { stdio: "ignore" }
  );
  return { child, userDataDir };
}

async function stopBrowser(browser) {
  const waitForExit = async (ms) => {
    await Promise.race([
      new Promise((resolve) => browser.child.once("exit", resolve)),
      delay(ms),
    ]);
  };
  if (browser.child.exitCode === null && browser.child.signalCode === null) {
    browser.child.kill("SIGTERM");
    await waitForExit(2000);
  }
  if (browser.child.exitCode === null && browser.child.signalCode === null) {
    browser.child.kill("SIGKILL");
    await waitForExit(2000);
  }
  await fs.rm(browser.userDataDir, { recursive: true, force: true });
}

async function runBrowserScenario(name, options) {
  const wasm = await fs.readFile(currentWasmPath);
  const routeCounts = new Map();
  let resultResolve;
  const resultPromise = new Promise((resolve) => {
    resultResolve = resolve;
  });
  const routeMode = options.routeMode || "success";
  const wasmMode = options.wasmMode || "success";

  return withServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(browserHtml(options));
      return;
    }
    if (url.pathname === "/__result") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        resultResolve(JSON.parse(body));
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (url.pathname === "/custom/current.wasm") {
      routeCounts.set(url.pathname, (routeCounts.get(url.pathname) || 0) + 1);
      res.writeHead(200, { "Content-Type": "application/wasm" });
      res.end(wasm);
      return;
    }
    if (url.pathname.startsWith("/dist/verification/")) {
      await serveStaticFile(
        res,
        routeDistPath(url.pathname),
        url.pathname.endsWith(".wasm")
          ? "application/wasm"
          : "text/javascript; charset=utf-8"
      );
      return;
    }
    if (url.pathname.startsWith("/assets/")) {
      const key = `${url.pathname}${url.search}`;
      routeCounts.set(key, (routeCounts.get(key) || 0) + 1);
      if (url.pathname.endsWith("sui_move_wasm.js")) {
        const baseKey = url.pathname;
        const hits = routeCounts.get(baseKey) || 0;
        if (routeMode === "missing") {
          responseText(res, 404, "missing route");
          return;
        }
        if (routeMode === "transient" && hits === 1 && !url.search) {
          responseText(res, 503, "warming route");
          return;
        }
      }
      if (url.pathname.endsWith(".wasm")) {
        const baseKey = url.pathname;
        const hits = routeCounts.get(baseKey) || 0;
        if (wasmMode === "missing") {
          responseText(res, 404, "missing wasm");
          return;
        }
        if (wasmMode === "transient" && hits === 1) {
          responseText(res, 503, "warming wasm");
          return;
        }
      }
      await serveStaticFile(
        res,
        routeAssetPath(url.pathname),
        url.pathname.endsWith(".wasm")
          ? "application/wasm"
          : "text/javascript; charset=utf-8"
      );
      return;
    }
    responseText(res, 404, "missing");
  }, async (baseUrl) => {
    const browser = await launchBrowser(`${baseUrl}/`);
    try {
      const result = await Promise.race([
        resultPromise,
        delay(browserTimeoutMs).then(() => {
          throw new Error(`${name}: timed out waiting for browser result`);
        }),
      ]);
      return { result, routeCounts };
    } finally {
      await stopBrowser(browser);
    }
  });
}

function countFor(counts, suffix) {
  let total = 0;
  for (const [pathKey, count] of counts) {
    if (pathKey.includes(suffix)) {
      total += count;
    }
  }
  return total;
}

async function runBrowserRouteChecks() {
  if (!(await pathExists(browserBin))) {
    throw new Error(`Browser binary not found: ${browserBin}. Set BROWSER_BIN.`);
  }

  const success = await runBrowserScenario("route success", {
    verifierAssetBaseUrl: "/assets",
  });
  if (success.result.failureStage === "wasm_init") {
    throw new Error(`route success failed at wasm_init: ${success.result.error}`);
  }
  if (countFor(success.routeCounts, "sui_move_wasm.js") !== 2) {
    throw new Error("route success should not issue status-probe requests");
  }
  if (countFor(success.routeCounts, retryQueryParam) !== 0) {
    throw new Error("route success should not use retry import specifiers");
  }

  const slash = await runBrowserScenario("route trailing slash", {
    verifierAssetBaseUrl: "/assets/",
  });
  if (slash.result.failureStage === "wasm_init") {
    throw new Error(`route trailing slash failed at wasm_init: ${slash.result.error}`);
  }

  const routeTransient = await runBrowserScenario("route transient", {
    verifierAssetBaseUrl: "/assets",
    routeMode: "transient",
  });
  if (routeTransient.result.failureStage === "wasm_init") {
    throw new Error(
      `route transient retry failed at wasm_init: ${routeTransient.result.error}`
    );
  }
  if (countFor(routeTransient.routeCounts, retryQueryParam) === 0) {
    throw new Error("route transient retry did not use retry import specifiers");
  }

  const routeMissing = await runBrowserScenario("route missing", {
    verifierAssetBaseUrl: "/assets",
    routeMode: "missing",
  });
  if (routeMissing.result.failureStage !== "wasm_init") {
    throw new Error("route 404 should fail at wasm_init");
  }
  if (countFor(routeMissing.routeCounts, retryQueryParam) !== 0) {
    throw new Error("route 404 should not retry with query specifiers");
  }

  const wasmTransient = await runBrowserScenario("wasm transient", {
    verifierAssetBaseUrl: "/assets",
    wasmMode: "transient",
  });
  if (wasmTransient.result.failureStage === "wasm_init") {
    throw new Error(
      `WASM transient retry failed at wasm_init: ${wasmTransient.result.error}`
    );
  }

  const wasmMissing = await runBrowserScenario("wasm missing", {
    verifierAssetBaseUrl: "/assets",
    wasmMode: "missing",
  });
  if (wasmMissing.result.failureStage !== "wasm_init") {
    throw new Error("WASM 404 should fail at wasm_init");
  }

  const custom = await runBrowserScenario("custom wasm ignores base", {
    verifierAssetBaseUrl: "/assets",
    customWasm: true,
  });
  if (countFor(custom.routeCounts, "/assets/") !== 0) {
    throw new Error("custom wasm override should not request routed verifier assets");
  }
}

async function runInvalidBaseUrlChecks() {
  const verifier = await import(
    new URL("../../dist/verification/index.js", import.meta.url)
  );
  const files = fixtureFiles();
  for (const verifierAssetBaseUrl of ["assets", "./assets", "../assets"]) {
    const result = await verifier.verifyMovePackageProvenance({
      files,
      resolvedDependencies: {
        files: JSON.stringify(files),
        dependencies: "[]",
        lockfileDependencies: "[]",
      },
      intent: "publish",
      reference: {
        modules: [fakeV6Module()],
        dependencies: [],
      },
      verifierAssetBaseUrl,
    });
    if (
      result.status !== "build_failure" ||
      result.failureStage !== "input_validation"
    ) {
      throw new Error(
        `${verifierAssetBaseUrl}: expected input_validation failure, got ${JSON.stringify(
          result
        )}`
      );
    }
  }
}

if (!(await pathExists(currentWasmPath))) {
  throw new Error(`Missing verification WASM artifact: ${currentWasmPath}`);
}

await runCurrentWasmRetryChecks();
await runInvalidBaseUrlChecks();
await runBrowserRouteChecks();

console.log("[OK] WASM loader resilience checks passed");
process.exit(0);
