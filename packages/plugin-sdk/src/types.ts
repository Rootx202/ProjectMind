import { SupportedAgentId } from '@projectmind/agent-sdk';

export type PlatformId = 'linux' | 'windows' | 'darwin';

export type McpTransportType = 'stdio' | 'sse' | 'none';

export type AutoInvocationType =
  | 'hooks_and_skills'
  | 'mcp_instructions_and_skills'
  | 'instructions_and_mcp'
  | 'manual_mcp_only';

export type ReloadSupportType = 'hot_reload' | 'restart_required' | 'command_reload';

export interface PluginPublisher {
  name: string;
  url?: string;
  email?: string;
}

export interface PluginRuntimeRequirements {
  node: string;
  projectmind: string;
}

export interface PluginCapabilities {
  mcpTransport: McpTransportType;
  nativePlugin: boolean;
  mcpServer: boolean;
  agentSkills: boolean;
  lifecycleHooks: boolean;
  instructionFile: boolean;
  automaticInvocationMechanism: AutoInvocationType;
  reloadSupport: ReloadSupportType;
  requiresRestartOnInstall: boolean;
  restartInstructions: string;
  officialDocsUrls: string[];
  documentedLimitations: string[];
}

export interface PluginPermissions {
  filesystem: string[];
  network: boolean;
  executeCommands: boolean;
  readEnv: boolean;
}

export interface PluginManifest {
  $schema?: string;
  id: SupportedAgentId;
  name: string;
  version: string;
  description: string;
  publisher: PluginPublisher;
  license: string;
  homepage?: string;
  repository?: string;
  supportedPlatforms: PlatformId[];
  supportedAgentVersions: string;
  runtimeRequirements: PluginRuntimeRequirements;
  capabilities: PluginCapabilities;
  permissions: PluginPermissions;
  entrypoints?: {
    mcpConfigTemplate?: string;
    instructionsFile?: string;
    skillDir?: string;
    hookRunner?: string;
    nativePluginManifest?: string;
  };
  installationInstructions: string;
  upgradeInstructions: string;
  removalInstructions: string;
  integrity?: {
    sha256?: string;
    files?: Record<string, string>;
  };
}

export interface AgentDetectionResult {
  installed: boolean;
  agentId: SupportedAgentId;
  displayName: string;
  version?: string;
  binaryPath?: string;
  configPath?: string;
  reason: string;
}

export interface AdapterInstallOptions {
  mcpServerScriptPath?: string;
  backupDir?: string;
  force?: boolean;
  enableAfterInstall?: boolean;
}

export interface AdapterInstallResult {
  agentId: SupportedAgentId;
  displayName: string;
  installed: boolean;
  filesCreatedOrUpdated: string[];
  backupsCreated: string[];
  requiresRestart: boolean;
  restartMessage: string;
  verification: AdapterVerifyResult;
}

export interface AdapterVerifyResult {
  agentId: SupportedAgentId;
  verified: boolean;
  checks: Array<{ name: string; passed: boolean; details: string }>;
}

export interface AdapterUninstallResult {
  agentId: SupportedAgentId;
  uninstalled: boolean;
  filesModifiedOrRemoved: string[];
}

export interface AdapterDisableResult {
  agentId: SupportedAgentId;
  disabled: boolean;
  filesModified: string[];
  message: string;
}

export interface AdapterEnableResult {
  agentId: SupportedAgentId;
  enabled: boolean;
  filesModified: string[];
  message: string;
}

export interface AdapterUpdateResult {
  agentId: SupportedAgentId;
  updated: boolean;
  filesUpdated: string[];
  backupsCreated: string[];
  verification: AdapterVerifyResult;
}

export interface AdapterRestoreResult {
  agentId: SupportedAgentId;
  restored: boolean;
  restoredFiles: string[];
  message: string;
}

export interface EnhancedAgentAdapter {
  readonly agentId: SupportedAgentId;
  readonly displayName: string;
  readonly capabilities: PluginCapabilities;
  readonly manifest: PluginManifest;

  detectInstallation(homeDir?: string): AgentDetectionResult;
  detectAgentVersion(homeDir?: string): string | undefined;
  detectConfigurationLocation(projectRoot: string, homeDir?: string): { workspaceConfig?: string; globalConfig?: string };
  detectMcpConfiguration(projectRoot: string): { configured: boolean; details: string };

  install(projectRoot: string, options?: AdapterInstallOptions): AdapterInstallResult;
  verify(projectRoot: string, options?: AdapterInstallOptions): AdapterVerifyResult;
  update(projectRoot: string, options?: AdapterInstallOptions): AdapterUpdateResult;
  disable(projectRoot: string): AdapterDisableResult;
  enable(projectRoot: string): AdapterEnableResult;
  uninstall(projectRoot: string): AdapterUninstallResult;
  restoreBackup(projectRoot: string, backupPath?: string): AdapterRestoreResult;
  reportCapabilities(): PluginCapabilities;
}

