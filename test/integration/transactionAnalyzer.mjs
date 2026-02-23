/**
 * Transaction-based fidelity testing utilities
 * Analyzes Publish/Upgrade transactions and compares bytecode
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";

const NETWORK = "mainnet";
const GRPC_URLS = {
  mainnet: "https://fullnode.mainnet.sui.io:443",
  testnet: "https://fullnode.testnet.sui.io:443",
  devnet:  "https://fullnode.devnet.sui.io:443",
};
const GRAPHQL_URLS = {
  mainnet: "https://graphql.mainnet.sui.io/graphql",
  testnet: "https://graphql.testnet.sui.io/graphql",
};

// gRPC client: fast, for recent/live transactions
const grpcClient = new SuiGrpcClient({ network: NETWORK, baseUrl: GRPC_URLS[NETWORK] });
// GraphQL client: full history, fallback for transactions pruned by gRPC nodes
const gqlClient = new SuiGraphQLClient({ url: GRAPHQL_URLS[NETWORK] });

// GraphQL query for full historical transaction data
const GQL_GET_TRANSACTION = `
query GetTransaction($digest: String!) {
  transaction(digest: $digest) {
    digest
    transactionBcs
    effects {
      status
      objectChanges {
        nodes {
          idCreated
          outputState { __typename address }
        }
      }
    }
  }
}`;

/**
 * Fetch transaction via gRPC. Falls back to GraphQL if gRPC node has pruned it.
 * @param {string} digest
 * @returns {{ bcsBytes: Uint8Array, packageId: string|null, timestamp: string|null, source: string }}
 */
async function fetchTransaction(digest) {
  // 1. Try gRPC first (fast, but only retains recent transactions)
  try {
    const result = await grpcClient.getTransaction({
      digest,
      include: { bcs: true, effects: true },
    });
    const tx = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
    if (!tx) throw new Error("No transaction result");

    const changedObjects = tx.effects?.changedObjects ?? [];
    // PackageWrite + Created = newly published immutable package
    const pkg = changedObjects.find(
      (o) => o.idOperation === "Created" && o.outputState === "PackageWrite"
    );
    return {
      bcsBytes: tx.bcs,          // Uint8Array
      packageId: pkg?.objectId ?? null,
      timestamp: tx.epoch ?? null,
      source: "grpc",
    };
  } catch (grpcErr) {
    // gRPC node pruned this transaction — fall back to GraphQL (full history)
    console.log(`[Tx] gRPC not found, trying GraphQL fallback...`);
  }

  // 2. Fallback: GraphQL (retains full mainnet history)
  const r = await gqlClient.query({ query: GQL_GET_TRANSACTION, variables: { digest } });
  if (r.errors?.length) throw new Error(r.errors[0].message);
  const tx = r.data?.transaction;
  if (!tx) throw new Error(`Transaction not found: ${digest}`);

  const bcsBytes = fromBase64(tx.transactionBcs);
  const nodes = tx.effects?.objectChanges?.nodes ?? [];
  // __typename is "Object" for regular objects, undefined/null for MovePackage
  // The package address matches the known packageId from the publish command output
  const pkgNode = nodes.find((n) => n.idCreated && !n.outputState?.__typename);
  const packageId = pkgNode?.outputState?.address ?? null;

  return {
    bcsBytes,
    packageId,
    timestamp: null,
    source: "graphql",
  };
}

/**
 * Analyze a transaction to determine if it's Publish or Upgrade
 * @param digest - Transaction digest
 * @returns Transaction info including type and modules
 */
export async function analyzeTransaction(digest) {
  const { bcsBytes, packageId, timestamp, source } = await fetchTransaction(digest);
  if (source === "graphql") {
    console.log(`[Tx] Fetched via GraphQL fallback`);
  }

  // Parse the BCS-encoded transaction to extract modules and dependencies
  // gRPC tx.bcs has a 4-byte SenderSignedData envelope prefix → slice(4)
  // GraphQL transactionBcs is pure TransactionData BCS → no slice needed
  const offset = source === "grpc" ? 4 : 0;
  const transaction = Transaction.from(toBase64(bcsBytes.slice(offset)));
  const data = transaction.getData();

  const upgradeCmd = data.commands.find((c) => c.$kind === "Upgrade");
  const publishCmd = data.commands.find((c) => c.$kind === "Publish");

  let txType = null;
  let modules = [];
  let dependencies = [];

  if (upgradeCmd?.Upgrade) {
    txType = "upgrade";
    modules = upgradeCmd.Upgrade.modules || [];
    dependencies = upgradeCmd.Upgrade.dependencies || [];
  } else if (publishCmd?.Publish) {
    txType = "publish";
    modules = publishCmd.Publish.modules || [];
    dependencies = publishCmd.Publish.dependencies || [];
  } else {
    throw new Error("No Publish or Upgrade command found in transaction");
  }

  return {
    digest,
    txType,
    modules,
    moduleCount: modules.length,
    dependencies,
    packageId,
    upgradeInfo: null, // upgrade tracing not needed for current fidelity tests
    timestamp,
  };
}

/**
 * Extract upgrade information from transaction
 */
async function extractUpgradeInfo(tx) {
  // effects.changedObjects replaces 1.x top-level objectChanges
  const changedObjects = tx.effects?.changedObjects || [];
  let currentPackageId = null;
  for (const change of changedObjects) {
    if (change.outputState === "PackageWrite" && change.idOperation === "Created") {
      currentPackageId = change.objectId;
      break;
    }
  }
  return { currentPackageId };
}



/**
 * Trace UpgradeCap back to the original publish transaction
 * @param upgradeCapId - UpgradeCap object ID
 * @returns Original package info
 */
export async function traceUpgradeCapToOriginal(upgradeCapId) {
  // Get UpgradeCap object
  // getObject is not available on SuiGrpcClient; use getObjects (plural) which
  // maps from 1.x multiGetObjects → 2.x client.getObjects per the method table.
  const [capObj] = await client.getObjects({
    ids: [upgradeCapId],
    include: {
      // TODO: confirm include flags — 1.x used showContent / showPreviousTransaction
      content: true,
      previousTransaction: true,
    },
  });

  if (!capObj?.data) {
    throw new Error(`UpgradeCap not found: ${upgradeCapId}`);
  }

  // UpgradeCap has a 'package' field pointing to the original package
  const content = capObj.data.content;
  const packageField = content?.fields?.package;

  if (packageField) {
    return {
      originalPackageId: packageField,
      note: "Extracted from UpgradeCap.package field",
    };
  }

  return { originalPackageId: null };
}

/**
 * Get modules from a deployed package
 * @param packageId - Package object ID
 * @returns Base64 encoded modules
 */
export async function getPackageModules(packageId) {
  // getObject → getObjects (plural) for 2.x gRPC
  const [pkg] = await client.getObjects({
    ids: [packageId],
    include: {
      // TODO: confirm include flag for BCS data — 1.x used showBcs: true
      bcs: true,
    },
  });

  if (!pkg?.data?.bcs?.moduleMap) {
    throw new Error(`Package modules not found: ${packageId}`);
  }

  const moduleMap = pkg.data.bcs.moduleMap;
  const moduleNames = Object.keys(moduleMap).sort();
  const modules = moduleNames.map((name) => moduleMap[name]);

  return { modules, moduleNames };
}

/**
 * Compare modules from WASM build with transaction modules
 */
export function compareModules(wasmModules, txModules) {
  const results = {
    match: true,
    wasmCount: wasmModules.length,
    txCount: txModules.length,
    details: [],
  };

  if (wasmModules.length !== txModules.length) {
    results.match = false;
  }

  const count = Math.max(wasmModules.length, txModules.length);
  for (let i = 0; i < count; i++) {
    const wasm = wasmModules[i];
    const tx = txModules[i];

    if (!wasm) {
      results.match = false;
      results.details.push({ index: i, status: "missing_wasm" });
    } else if (!tx) {
      results.match = false;
      results.details.push({ index: i, status: "missing_tx" });
    } else if (wasm === tx) {
      results.details.push({ index: i, status: "match" });
    } else {
      results.match = false;
      const wasmBuf = Buffer.from(wasm, "base64");
      const txBuf = Buffer.from(tx, "base64");
      results.details.push({
        index: i,
        status: "mismatch",
        wasmSize: wasmBuf.length,
        txSize: txBuf.length,
        wasmHash: wasmBuf.slice(0, 8).toString("hex"),
        txHash: txBuf.slice(0, 8).toString("hex"),
      });
    }
  }

  return results;
}

/**
 * Generate Published.toml content for upgrade testing
 */
export function generatePublishedToml(
  originalId,
  publishedAt,
  chainId,
  version
) {
  return `# Generated for fidelity testing
[published.mainnet]
chain-id = "${chainId}"
original-id = "${originalId}"
published-at = "${publishedAt}"
version = ${version}
`;
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const digest = process.argv[2];
  if (!digest) {
    console.log("Usage: node transactionAnalyzer.mjs <tx_digest>");
    process.exit(1);
  }

  console.log(`Analyzing transaction: ${digest}`);
  analyzeTransaction(digest)
    .then((info) => {
      console.log(JSON.stringify(info, null, 2));
    })
    .catch((e) => {
      console.error("Error:", e.message);
      process.exit(1);
    });
}
