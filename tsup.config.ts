import { defineConfig } from "tsup";

const entry = process.env.SUI_MOVE_BUILDER_ENTRY || "src/index.ts";

export default defineConfig({
  entry: { index: entry },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: process.env.SOURCEMAP === "true",
  minify: true,
  clean: false,
  outDir: "dist",
  target: "es2020",
  external: ["./sui_move_wasm.js", "./sui_move_wasm_bg.wasm"],
});
