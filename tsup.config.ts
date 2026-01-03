import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: process.env.SOURCEMAP === "true",
  minify: true,
  clean: true,
  outDir: "dist",
  target: "es2020",
  external: ["./sui_move_wasm.js"],
});
