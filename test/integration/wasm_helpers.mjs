import { readFile } from "node:fs/promises";

export async function loadWasmBindings(variant = "full") {
  if (variant !== "full" && variant !== "lite" && variant !== "verification") {
    throw new Error(
      `WASM variant must be 'full', 'lite', or 'verification', got: ${variant}`
    );
  }

  const mod = await import(
    new URL(`../../dist/${variant}/sui_move_wasm.js`, import.meta.url)
  );
  try {
    mod.sui_version();
    return mod;
  } catch {
    // Initialize below when this helper is the first raw binding user.
  }
  const wasmBytes = await readFile(
    new URL(`../../dist/${variant}/sui_move_wasm_bg.wasm`, import.meta.url)
  );
  await mod.default({ module_or_path: wasmBytes });
  return mod;
}
