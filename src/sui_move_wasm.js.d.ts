export interface CompileResult {
  success(): boolean;
  output(): string;
}

export function compile(
  filesJson: string,
  depsJson: string,
  optionsJson?: string
): CompileResult;
export function sui_move_version(): string;
export function sui_version(): string;
export function compute_manifest_digest(depsJson: string): string;
export default function init(wasm?: string | URL): Promise<void>;
