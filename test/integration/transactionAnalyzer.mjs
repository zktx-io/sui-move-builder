/**
 * Transaction-based fidelity testing utilities
 * Analyzes Publish/Upgrade transactions and compares bytecode
 */
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";

const NETWORK = "mainnet";
const client = new SuiClient({ url: getFullnodeUrl(NETWORK) });

/**
 * Analyze a transaction to determine if it's Publish or Upgrade
 * @param digest - Transaction digest
 * @returns Transaction info including type and modules
 */
export async function analyzeTransaction(digest) {
  const receipt = await client.getTransactionBlock({
    digest,
    options: {
      showRawInput: true,
      showEffects: true,
      showObjectChanges: true,
    },
  });

  if (!receipt.effects || !receipt.effects.created) {
    throw new Error("Transaction not found or has no created objects");
  }

  // Find the immutable package object
  const immutable = receipt.effects.created.find(
    (o) => o.owner === "Immutable"
  );
  const packageId = immutable?.reference?.objectId || null;

  // Parse the raw transaction to extract modules
  const transaction = Transaction.from(
    toBase64(fromBase64(receipt.rawTransaction).slice(4))
  );
  const data = transaction.getData();

  const upgradeCmd = data.commands.find((c) => c.$kind === "Upgrade");
  const publishCmd = data.commands.find((c) => c.$kind === "Publish");

  let txType = null;
  let modules = [];
  let dependencies = [];

  if (upgradeCmd && upgradeCmd.Upgrade) {
    txType = "upgrade";
    modules = upgradeCmd.Upgrade.modules || [];
    dependencies = upgradeCmd.Upgrade.dependencies || [];
  } else if (publishCmd && publishCmd.Publish) {
    txType = "publish";
    modules = publishCmd.Publish.modules || [];
    dependencies = publishCmd.Publish.dependencies || [];
  } else {
    throw new Error("No Publish or Upgrade command found in transaction");
  }

  // For upgrades, trace UpgradeCap to find original package
  let upgradeInfo = null;
  if (txType === "upgrade") {
    upgradeInfo = await extractUpgradeInfo(receipt);
  }

  return {
    digest,
    txType,
    modules,
    moduleCount: modules.length,
    dependencies,
    packageId,
    upgradeInfo,
    timestamp: receipt.timestampMs,
  };
}

/**
 * Extract upgrade information from transaction
 */
async function extractUpgradeInfo(receipt) {
  // Find UpgradeCap from object changes or inputs
  const objectChanges = receipt.objectChanges || [];

  let currentPackageId = null;
  for (const change of objectChanges) {
    if (change.type === "published") {
      currentPackageId = change.packageId;
      break;
    }
  }

  // Try to find UpgradeCap object that was used as input
  // This requires parsing the transaction inputs
  // For now, return what we have
  return { currentPackageId };
}

/**
 * Trace UpgradeCap back to the original publish transaction
 * @param upgradeCapId - UpgradeCap object ID
 * @returns Original package info
 */
export async function traceUpgradeCapToOriginal(upgradeCapId) {
  // Get UpgradeCap object
  const capObj = await client.getObject({
    id: upgradeCapId,
    options: {
      showContent: true,
      showPreviousTransaction: true,
    },
  });

  if (!capObj.data) {
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
  const pkg = await client.getObject({
    id: packageId,
    options: {
      showBcs: true,
    },
  });

  if (!pkg.data?.bcs?.moduleMap) {
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
