export interface WasmCompileResult {
  success(): boolean;
  output(): string;
}

export function compile(
  filesJson: string,
  depsJson: string,
  optionsJson?: string
): WasmCompileResult;
export interface WasmTestResult {
  passed: boolean;
  output: string;
}
export function test(filesJson: string, depsJson: string): WasmTestResult;
export function test_with_options(
  filesJson: string,
  depsJson: string,
  optionsJson: string
): WasmTestResult;
export function sui_move_version(): string;
export function sui_version(): string;
export function compute_manifest_digest(depsJson: string): string;
export function compute_manifest_digest_from_move_toml(
  moveToml: string,
  packageNameOverride: string | undefined,
  environment: string
): string;
export function lockfile_v4_fetch_plan(
  moveLockToml: string,
  environment: string
): string;
export function lockfile_v4_validate_graph(inputJson: string): string;
export function lockfile_v4_resolve_package_groups(inputJson: string): string;
export function manifest_graph_resolve_package_groups(
  inputJson: string
): string;
export function root_publication_metadata(inputJson: string): string;
export function lockfile_v4_generate(inputJson: string): string;
export default function init(
  wasm?:
    | string
    | URL
    | BufferSource
    | { module_or_path?: string | URL | BufferSource }
): Promise<void>;
