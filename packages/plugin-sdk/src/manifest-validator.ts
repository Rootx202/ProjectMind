import { PluginManifest } from './types';
import { SupportedAgentId } from '@projectmind/agent-sdk';

const VALID_AGENT_IDS: Set<string> = new Set([
  'antigravity',
  'codex',
  'claude-code',
  'gemini-cli',
  'cursor',
  'github-copilot',
  'opencode',
  'hermes-agent',
  'deepseek-harness'
]);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export class ManifestValidator {
  public static validate(manifest: unknown): ValidationResult {
    const errors: string[] = [];

    if (!manifest || typeof manifest !== 'object') {
      return { valid: false, errors: ['Manifest must be a non-null object.'] };
    }

    const m = manifest as Partial<PluginManifest>;

    if (!m.id || typeof m.id !== 'string') {
      errors.push('Manifest missing required "id" string.');
    } else if (!VALID_AGENT_IDS.has(m.id)) {
      errors.push(`Manifest "id" must be one of: ${Array.from(VALID_AGENT_IDS).join(', ')}.`);
    }

    if (!m.name || typeof m.name !== 'string' || m.name.trim().length === 0) {
      errors.push('Manifest missing required "name" string.');
    }

    if (!m.version || typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) {
      errors.push('Manifest "version" must follow semantic versioning (e.g. 1.0.0).');
    }

    if (!m.description || typeof m.description !== 'string' || m.description.trim().length === 0) {
      errors.push('Manifest missing required "description" string.');
    }

    if (!m.publisher || typeof m.publisher !== 'object' || !m.publisher.name) {
      errors.push('Manifest missing required "publisher.name" string.');
    }

    if (!Array.isArray(m.supportedPlatforms) || m.supportedPlatforms.length === 0) {
      errors.push('Manifest must specify at least one supported platform in "supportedPlatforms".');
    } else {
      for (const p of m.supportedPlatforms) {
        if (!['linux', 'windows', 'darwin'].includes(p)) {
          errors.push(`Invalid platform "${p}" in "supportedPlatforms".`);
        }
      }
    }

    if (!m.supportedAgentVersions || typeof m.supportedAgentVersions !== 'string') {
      errors.push('Manifest missing required "supportedAgentVersions" constraint.');
    }

    if (!m.runtimeRequirements || typeof m.runtimeRequirements !== 'object' || !m.runtimeRequirements.node) {
      errors.push('Manifest missing "runtimeRequirements.node".');
    }

    if (!m.capabilities || typeof m.capabilities !== 'object') {
      errors.push('Manifest missing "capabilities" specification.');
    } else {
      const c = m.capabilities;
      if (!['stdio', 'sse', 'none'].includes(c.mcpTransport)) {
        errors.push('Invalid capability "mcpTransport"; expected "stdio", "sse", or "none".');
      }
      if (!['hooks_and_skills', 'mcp_instructions_and_skills', 'instructions_and_mcp', 'manual_mcp_only'].includes(c.automaticInvocationMechanism)) {
        errors.push(`Invalid capability "automaticInvocationMechanism": "${c.automaticInvocationMechanism}".`);
      }
      if (!['hot_reload', 'restart_required', 'command_reload'].includes(c.reloadSupport)) {
        errors.push(`Invalid capability "reloadSupport": "${c.reloadSupport}".`);
      }
    }

    if (!m.permissions || typeof m.permissions !== 'object' || !Array.isArray(m.permissions.filesystem)) {
      errors.push('Manifest missing "permissions.filesystem" array.');
    }

    if (!m.installationInstructions || typeof m.installationInstructions !== 'string') {
      errors.push('Manifest missing "installationInstructions".');
    }

    if (!m.removalInstructions || typeof m.removalInstructions !== 'string') {
      errors.push('Manifest missing "removalInstructions".');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

