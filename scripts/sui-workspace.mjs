import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export const SUI_REPO_URL = "https://github.com/MystenLabs/sui.git";

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

export function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "pipe", ...options });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} exited with code ${code}${stderr ? `\n${stderr}` : ""}`
          )
        );
      }
    });
  });
}

export async function dirExists(dir) {
  try {
    await fs.access(dir);
    return true;
  } catch {
    return false;
  }
}

function readFlagValue(argv, index, flagName, inlineValue) {
  if (inlineValue !== undefined) {
    return { value: inlineValue, nextIndex: index };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flagName} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

export function splitSuiVersionArgs(argv) {
  const overrides = {};
  const restArgs = [];

  for (let i = 0; i < argv.length; i += 1) {
    const rawArg = argv[i];
    const [flagName, inlineValue] = rawArg.split(/=(.*)/s, 2);
    let key;

    if (flagName === "--sui-version") key = "version";
    else if (flagName === "--sui-tag") key = "tag";
    else if (flagName === "--sui-commit") key = "commit";
    else if (flagName === "--sui-template-version") key = "templateVersion";
    else if (flagName === "--sui-repo") key = "repo";

    if (!key) {
      restArgs.push(rawArg);
      continue;
    }

    const parsed = readFlagValue(argv, i, flagName, inlineValue);
    overrides[key] = parsed.value;
    i = parsed.nextIndex;
  }

  return { overrides, restArgs };
}

function applyVersionLayer(config, layer) {
  const hasTag = Object.hasOwn(layer, "tag");
  const hasCommit = Object.hasOwn(layer, "commit");

  if (hasTag) {
    config.tag = layer.tag || undefined;
    if (!hasCommit) delete config.commit;
  }
  if (hasCommit) {
    config.commit = layer.commit || undefined;
    if (!hasTag) delete config.tag;
  }
  if (Object.hasOwn(layer, "version")) {
    config.version = layer.version || undefined;
  }
  if (Object.hasOwn(layer, "templateVersion")) {
    config.templateVersion = layer.templateVersion || undefined;
  }
  if (Object.hasOwn(layer, "repo")) {
    config.repo = layer.repo || undefined;
  }

  return config;
}

function nonEmptyEnvOverrides(env) {
  const overrides = {};
  if (env.SUI_VERSION) overrides.version = env.SUI_VERSION;
  if (env.SUI_TAG) overrides.tag = env.SUI_TAG;
  if (env.SUI_COMMIT) overrides.commit = env.SUI_COMMIT;
  if (env.SUI_TEMPLATE_VERSION) {
    overrides.templateVersion = env.SUI_TEMPLATE_VERSION;
  }
  if (env.SUI_REPO_URL) overrides.repo = env.SUI_REPO_URL;
  return overrides;
}

export function resolveSuiVersionConfig(
  baseConfig,
  argv = [],
  env = process.env
) {
  const { overrides: cliOverrides, restArgs } = splitSuiVersionArgs(argv);
  const config = { ...baseConfig };

  applyVersionLayer(config, nonEmptyEnvOverrides(env));
  applyVersionLayer(config, cliOverrides);

  if (!config.commit && !config.tag) {
    throw new Error("Sui version config must define commit or tag");
  }
  if (!config.version && !config.templateVersion) {
    throw new Error(
      "Sui version config must define version or templateVersion"
    );
  }

  return { suiVersion: config, restArgs };
}

export function getSuiBuildConfig(repoRoot, suiVersion) {
  const buildWorkspaceDir = path.join(repoRoot, ".sui-build");
  const tag = suiVersion.tag;
  const commit = suiVersion.commit;
  const checkoutRef = tag ? `refs/tags/${tag}` : commit;

  if (!checkoutRef) {
    throw new Error("sui-version.json must define either tag or commit");
  }

  return {
    repoRoot,
    buildWorkspaceDir,
    sourceDir: process.env.SUI_SOURCE_DIR
      ? path.resolve(process.env.SUI_SOURCE_DIR)
      : path.join(buildWorkspaceDir, "source"),
    workDir: process.env.SUI_WORK_DIR
      ? path.resolve(process.env.SUI_WORK_DIR)
      : path.join(buildWorkspaceDir, "work"),
    repoUrl: suiVersion.repo || SUI_REPO_URL,
    tag,
    commit,
    checkoutRef,
    displayRef: tag || commit,
    templateVersion: suiVersion.templateVersion || `v${suiVersion.version}`,
  };
}

async function ensureOriginRemote(sourceDir, repoUrl) {
  try {
    await run("git", ["remote", "set-url", "origin", repoUrl], {
      cwd: sourceDir,
      stdio: "ignore",
    });
  } catch {
    await run("git", ["remote", "add", "origin", repoUrl], {
      cwd: sourceDir,
    });
  }
}

async function hasExpectedSourceCheckout(config) {
  if (!(await dirExists(config.sourceDir))) {
    return false;
  }

  let head;
  try {
    head = await resolveSuiSourceCommit(config);
  } catch {
    return false;
  }

  if (config.commit && head === config.commit) {
    return true;
  }

  if (config.tag) {
    try {
      const { stdout } = await runCapture(
        "git",
        ["rev-parse", `${config.checkoutRef}^{commit}`],
        { cwd: config.sourceDir }
      );
      return stdout.trim() === head;
    } catch {
      return false;
    }
  }

  return false;
}

export async function ensureSuiSourceCheckout(config) {
  await fs.mkdir(path.dirname(config.sourceDir), { recursive: true });

  if (await hasExpectedSourceCheckout(config)) {
    console.log(`Using existing pristine Sui source ${config.displayRef}.`);
    return;
  }

  if (!(await dirExists(config.sourceDir))) {
    console.log(`Cloning pristine Sui source at ${config.displayRef}...`);
    await run("git", ["init", config.sourceDir]);
  }

  await ensureOriginRemote(config.sourceDir, config.repoUrl);

  console.log(`Fetching pristine Sui source ${config.displayRef}...`);
  if (config.tag) {
    await run(
      "git",
      [
        "fetch",
        "--depth",
        "1",
        "origin",
        `refs/tags/${config.tag}:refs/tags/${config.tag}`,
      ],
      { cwd: config.sourceDir }
    );
  } else {
    await run("git", ["fetch", "--depth", "1", "origin", config.commit], {
      cwd: config.sourceDir,
    });
  }

  await run("git", ["reset", "--hard", config.checkoutRef], {
    cwd: config.sourceDir,
  });

  if (config.commit) {
    const resolvedCommit = await resolveSuiSourceCommit(config);
    if (resolvedCommit !== config.commit) {
      throw new Error(
        `Sui checkout mismatch for ${config.displayRef}: expected ${config.commit}, got ${resolvedCommit}`
      );
    }
  }
}

export async function resolveSuiSourceCommit(config) {
  const { stdout } = await runCapture("git", ["rev-parse", "HEAD"], {
    cwd: config.sourceDir,
  });
  return stdout.trim();
}

export async function prepareSuiWorktree(config, options = {}) {
  const workDir = options.workDir || config.workDir;
  const updateSubmodules = options.updateSubmodules !== false;

  console.log(`Preparing Sui worktree at ${workDir}...`);
  await fs.mkdir(path.dirname(workDir), { recursive: true });

  if (await dirExists(workDir)) {
    try {
      await run("git", ["worktree", "remove", "--force", workDir], {
        cwd: config.sourceDir,
        stdio: "ignore",
      });
    } catch {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  await run("git", ["worktree", "prune"], {
    cwd: config.sourceDir,
    stdio: "ignore",
  });
  await run(
    "git",
    ["worktree", "add", "--detach", workDir, config.checkoutRef],
    {
      cwd: config.sourceDir,
    }
  );

  if (updateSubmodules) {
    console.log("Updating Sui worktree submodules...");
    await run("git", ["submodule", "update", "--init", "--recursive"], {
      cwd: workDir,
    });
  }

  return workDir;
}
