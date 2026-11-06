import * as fs from 'node:fs';
import * as path from 'node:path';
import { PluginManifest } from './types';
import { SupportedAgentId } from '@projectmind/agent-sdk';
import { RuntimeResolver } from './runtime-resolver';

export class PluginRegistry {
  private static cachedManifests: Map<SupportedAgentId, PluginManifest> | null = null;

  public static getPluginsDirectory(): string {
    // 1. PROJECTMIND_HOME/plugins
    if (process.env.PROJECTMIND_HOME && fs.existsSync(path.join(process.env.PROJECTMIND_HOME, 'plugins'))) {
      return path.join(process.env.PROJECTMIND_HOME, 'plugins');
    }

    // 2. Search upward from current location for `plugins` folder
    let curr = path.resolve(__dirname);
    for (let i = 0; i < 7; i++) {
      const cand = path.join(curr, 'plugins');
      if (fs.existsSync(cand) && fs.existsSync(path.join(cand, 'manifest.schema.json'))) {
        return cand;
      }
      const parent = path.dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }

    // 3. Runtime resolver home
    try {
      const runtime = RuntimeResolver.resolveRuntime();
      const cand = path.join(runtime.homeDir, 'plugins');
      if (fs.existsSync(cand)) return cand;
    } catch (_) {}

    return path.resolve(__dirname, '..', '..', '..', 'plugins');
  }

  public static loadManifest(agentId: SupportedAgentId): PluginManifest | null {
    const pluginsDir = this.getPluginsDirectory();
    const manifestPath = path.join(pluginsDir, agentId, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;

    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PluginManifest;
    } catch (err) {
      process.stderr.write(`[ProjectMind Registry Warning] Failed to parse manifest for ${agentId}: ${err}\n`);
      return null;
    }
  }

  public static getAllManifests(): PluginManifest[] {
    if (this.cachedManifests) {
      return Array.from(this.cachedManifests.values());
    }

    const map = new Map<SupportedAgentId, PluginManifest>();
    const pluginsDir = this.getPluginsDirectory();

    if (fs.existsSync(pluginsDir)) {
      for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(pluginsDir, entry.name, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PluginManifest;
            map.set(parsed.id, parsed);
          } catch (_) {}
        }
      }
    }

    this.cachedManifests = map;
    return Array.from(map.values());
  }

  public static search(query: string): PluginManifest[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.getAllManifests();

    return this.getAllManifests().filter((m) => {
      const inId = m.id.toLowerCase().includes(q);
      const inName = m.name.toLowerCase().includes(q);
      const inDesc = m.description.toLowerCase().includes(q);
      const inMech = m.capabilities.automaticInvocationMechanism.toLowerCase().includes(q);
      const inKeywords = Array.isArray((m as any).keywords) && (m as any).keywords.some((k: string) => k.toLowerCase().includes(q));
      const inCaps =
        (q === 'mcp' && m.capabilities.mcpServer) ||
        (q === 'hook' || q === 'hooks' && m.capabilities.lifecycleHooks) ||
        (q === 'skill' || q === 'skills' && m.capabilities.agentSkills) ||
        (q === 'rule' || q === 'rules' && m.capabilities.instructionFile);
      return inId || inName || inDesc || inMech || inKeywords || inCaps;
    });
  }
}
