// Public surface of the config domain: types, discovery/loading, validation
// results, output_to resolution and effective limits.

export type {
  ArgSpec,
  CheckSpec,
  CommandSpec,
  GroupSpec,
  Limits,
  LoadedConfig,
  NormalizedOutputTo,
} from "./types.js";
export { AGENT_FILENAME_RE, CHECK_RULES, OUTPUT_TO_EXTENSIONS } from "./types.js";
export { agentsDir, homeDir, loadConfig, parseConfigFile, projectDir } from "./load.js";
export {
  AGENT_CONFIG_FILE,
  agentConfigPath,
  configCandidates,
  projectProposalPath,
  projectSlug,
  STORE_CONFIG_FILE,
  storeConfigPath,
  storeDir,
} from "./discover.js";
export {
  emitAgentGroups,
  readAgentGroups,
  removeAgentCommand,
  upsertAgentCommand,
  validateAgentProposal,
  withAgentLock,
  writeAgentGroups,
} from "./agent.js";
export { normalizeOutputTo, resolveOutputTo } from "./output.js";
export { validateConfig } from "./validate.js";
export { effectiveLimits } from "./limits.js";
