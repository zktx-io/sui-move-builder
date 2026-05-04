import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./parity_helpers.mjs";

export async function readGithubToken() {
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }
  try {
    return (
      await fs.readFile(path.join(repoRoot, "test/.github_token"), "utf8")
    ).trim();
  } catch {
    return undefined;
  }
}

export function parseGitHubUrl(gitUrl) {
  const url = new URL(gitUrl);
  const parts = url.pathname
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (url.hostname.toLowerCase() !== "github.com" || parts.length < 2) {
    throw new Error(`Expected GitHub URL, got ${gitUrl}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

export async function fetchGitHubTree({ git, commit, token }) {
  const { owner, repo } = parseGitHubUrl(git);
  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`;
  const response = await fetch(treeUrl, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch GitHub tree ${owner}/${repo}@${commit}: ${response.status} ${response.statusText}`
    );
  }
  const body = await response.json();
  if (body.truncated === true) {
    throw new Error(
      `GitHub tree response is truncated for ${owner}/${repo}@${commit}; artifact audit requires a complete tree`
    );
  }
  if (!Array.isArray(body.tree)) {
    throw new Error(
      `GitHub tree response has no tree array for ${owner}/${repo}@${commit}`
    );
  }
  return { owner, repo, tree: body.tree };
}

export async function writeGitHubSourceSnapshot({
  git,
  commit,
  packagePath,
  outputDir,
  token,
}) {
  const { owner, repo, tree } = await fetchGitHubTree({ git, commit, token });
  const normalizedPackagePath = packagePath?.replace(/\/+$/, "");
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  for (const item of tree) {
    if (
      item.type !== "blob" ||
      !isIncludedMovePackageFile(item.path) ||
      (normalizedPackagePath &&
        item.path !== normalizedPackagePath &&
        !item.path.startsWith(`${normalizedPackagePath}/`))
    ) {
      continue;
    }
    const content = await fetchGitHubRawText({
      owner,
      repo,
      commit,
      repoPath: item.path,
      token,
    });
    const target = path.join(outputDir, item.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  return { owner, repo, tree };
}

export async function fetchGitHubBinaryModules({
  git,
  commit,
  binaryArtifactPath,
  token,
}) {
  const normalizedPrefix = binaryArtifactPath.replace(/\/+$/, "");
  const { owner, repo, tree } = await fetchGitHubTree({ git, commit, token });
  const moduleItems = tree
    .filter(
      (item) =>
        item.type === "blob" &&
        item.path.startsWith(`${normalizedPrefix}/`) &&
        item.path.endsWith(".mv")
    )
    .sort((left, right) => left.path.localeCompare(right.path));

  if (moduleItems.length === 0) {
    throw new Error(
      `No committed .mv modules found under ${binaryArtifactPath} in ${git}@${commit}`
    );
  }

  const namedModules = [];
  for (const item of moduleItems) {
    const bytes = await fetchGitHubRawBytes({
      owner,
      repo,
      commit,
      repoPath: item.path,
      token,
    });
    namedModules.push({
      name: path.basename(item.path, ".mv"),
      base64: Buffer.from(bytes).toString("base64"),
      path: item.path,
    });
  }
  return namedModules;
}

function isIncludedMovePackageFile(repoPath) {
  const fileName = path.posix.basename(repoPath);
  return (
    repoPath.endsWith(".move") ||
    fileName === "Move.toml" ||
    fileName === "Move.lock" ||
    fileName === "Published.toml" ||
    /^Move\.[^.\\/]+\.toml$/.test(fileName)
  );
}

async function fetchGitHubRawText(input) {
  const bytes = await fetchGitHubRawBytes(input);
  return Buffer.from(bytes).toString("utf8");
}

async function fetchGitHubRawBytes({ owner, repo, commit, repoPath, token }) {
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${repoPath}`;
  const response = await fetch(rawUrl, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch GitHub raw file ${owner}/${repo}@${commit}:${repoPath}: ${response.status} ${response.statusText}`
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

function githubHeaders(token) {
  const headers = { accept: "application/vnd.github+json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}
