import {
  runContentDriftFallback,
  runLocalSourcePin,
  runMissingMoveTomlSnapshot,
  runResolvedShaPin,
  runStaleDigestFallback,
} from "./lockfile_v4_pin_fallback_test.mjs";
import {
  runMalformedGraphStructure,
  runMalformedImplicitTarget,
} from "./lockfile_v4_graph_validation_test.mjs";
import {
  runEnvironmentPackageGroups,
  runExplicitSystemAliases,
  runSameNamePackageIds,
} from "./lockfile_v4_package_groups_test.mjs";
import {
  runLegacyTransitiveNamedAddresses,
  runLinkageFiltering,
} from "./lockfile_v4_linkage_test.mjs";

await runStaleDigestFallback();
await runMalformedGraphStructure();
await runResolvedShaPin();
await runMalformedImplicitTarget();
await runContentDriftFallback();
await runSameNamePackageIds();
await runExplicitSystemAliases();
await runEnvironmentPackageGroups();
await runLocalSourcePin();
await runMissingMoveTomlSnapshot();
await runLinkageFiltering();
await runLegacyTransitiveNamedAddresses();
