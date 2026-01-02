import { Resolver } from "./resolver.js";
import { parseToml } from "./toml_parser.js";

/**
 * Resolves dependencies and prepares input for the WASM compiler.
 *
 * @param {string} rootMoveTomlContent - Content of the root Move.toml
 * @param {Object} rootSourceFiles - Map of "filename" -> "content" for root source files
 * @param {Object} fetcher - Implementation of Fetcher interface
 * @returns {Promise<{files: string, dependencies: string}>} - JSON strings ready for compile()
 */
export async function resolve(rootMoveTomlContent, rootSourceFiles, fetcher) {
  const resolver = new Resolver(fetcher);
  return await resolver.resolve(rootMoveTomlContent, rootSourceFiles);
}
