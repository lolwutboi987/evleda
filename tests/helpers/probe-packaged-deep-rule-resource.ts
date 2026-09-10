import { loadDeepRuleResource } from "../../src/harness/deep-rule-catalog.js";

const resource = loadDeepRuleResource();
process.stdout.write(JSON.stringify({
  resourceDirectory: resource.profile.resourceDirectory,
  resourceIdentity: resource.resourceIdentity,
  catalogSha256: resource.catalogSha256,
  ruleCount: resource.catalog.rules.length,
  dossierCount: resource.catalog.sourceDossiers.length
}));
