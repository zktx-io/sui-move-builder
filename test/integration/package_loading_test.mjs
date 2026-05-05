import { runGitHubPublishedTomlCase } from "./package_loading_github_published_cases.mjs";
import { runGitHubRootFetchCases } from "./package_loading_github_root_cases.mjs";
import { runGitHubSymlinkCases } from "./package_loading_github_symlink_cases.mjs";
import { runLocalPackageLoadingCases } from "./package_loading_local_cases.mjs";

await runLocalPackageLoadingCases();
await runGitHubRootFetchCases();
await runGitHubPublishedTomlCase();
await runGitHubSymlinkCases();
