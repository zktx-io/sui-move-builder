import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const variants = [
  {
    name: "full esm",
    load: () => import(new URL("../../dist/full/index.js", import.meta.url)),
  },
  {
    name: "full cjs",
    load: () => require("../../dist/full/index.cjs"),
  },
  {
    name: "lite esm",
    load: () => import(new URL("../../dist/lite/index.js", import.meta.url)),
  },
  {
    name: "lite cjs",
    load: () => require("../../dist/lite/index.cjs"),
  },
];

for (const variant of variants) {
  const mod = await variant.load();

  if (typeof mod.initMoveCompiler !== "function") {
    throw new Error(`${variant.name}: missing initMoveCompiler export`);
  }
  if (typeof mod.getSuiVersion !== "function") {
    throw new Error(`${variant.name}: missing getSuiVersion export`);
  }

  await mod.initMoveCompiler();
  const version = await mod.getSuiVersion();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`${variant.name}: unexpected Sui version '${version}'`);
  }

  console.log(`[OK] ${variant.name}: sui ${version}`);
}
