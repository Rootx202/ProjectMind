import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { getOsDirectoryLayout } from './os-paths';

export interface ResolvedRuntime {
  homeDir: string;
  sdkEntryPath: string;
  mcpServerCliPath: string;
  source: 'env_projectmind_home' | 'node_module_resolution' | 'global_installation' | 'repo_checkout';
}

export interface TargetProjectRootOptions {
  explicitRoot?: string;
  payloadRoot?: string;
  agentEnvRoot?: string;
  cwd?: string;
  allowSelfRoot?: boolean;
}

export class RuntimeResolver {
  /**
   * Resolves the ProjectMind runtime installation root and SDK entry point.
   * Order:
   * 1. PROJECTMIND_HOME environment variable
   * 2. Installed package / node module resolution (@projectmind/agent-sdk)
   * 3. Global OS directory layout installation
   * 4. Repository checkout relative paths
   */
  public static resolveRuntime(customHome?: string): ResolvedRuntime {
    // 1. Explicit PROJECTMIND_HOME
    const envHome = customHome || process.env.PROJECTMIND_HOME;
    if (envHome && fs.existsSync(envHome)) {
      const resolvedEnvHome = path.resolve(envHome);
      const sdkPath = this.findSdkInRoot(resolvedEnvHome);
      const mcpPath = this.findMcpInRoot(resolvedEnvHome);
      if (sdkPath && mcpPath) {
        return {
          homeDir: resolvedEnvHome,
          sdkEntryPath: sdkPath,
          mcpServerCliPath: mcpPath,
          source: 'env_projectmind_home'
        };
      }
    }

    // 2. Installed package / node_modules resolution
    try {
      const localReq = createRequire(__filename);
      const resolvedSdkPkg = localReq.resolve('@projectmind/agent-sdk');
      if (resolvedSdkPkg && fs.existsSync(resolvedSdkPkg)) {
        const homeDir = this.searchProjectMindRoot(path.dirname(resolvedSdkPkg));
        const mcpPath = this.findMcpInRoot(homeDir) || resolvedSdkPkg;
        return {
          homeDir,
          sdkEntryPath: resolvedSdkPkg,
          mcpServerCliPath: mcpPath,
          source: 'node_module_resolution'
        };
      }
    } catch (_) {}

    // 3. Global OS directory installation
    const osLayout = getOsDirectoryLayout();
    for (const candDir of [
      osLayout.dataDir,
      path.join(osLayout.dataDir, 'package'),
      path.join(osLayout.binDir, '..', 'lib', 'projectmind')
    ]) {
      if (fs.existsSync(candDir)) {
        const sdkPath = this.findSdkInRoot(candDir);
        const mcpPath = this.findMcpInRoot(candDir);
        if (sdkPath && mcpPath) {
          return {
            homeDir: candDir,
            sdkEntryPath: sdkPath,
            mcpServerCliPath: mcpPath,
            source: 'global_installation'
          };
        }
      }
    }

    // 4. Repository checkout relative paths
    let currentDir = path.resolve(__dirname);
    for (let i = 0; i < 7; i++) {
      const pkgJsonPath = path.join(currentDir, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          if (pkg.name === 'projectmind') {
            const sdkPath = this.findSdkInRoot(currentDir);
            const mcpPath = this.findMcpInRoot(currentDir);
            if (sdkPath && mcpPath) {
              return {
                homeDir: currentDir,
                sdkEntryPath: sdkPath,
                mcpServerCliPath: mcpPath,
                source: 'repo_checkout'
              };
            }
          }
        } catch (_) {}
      }
      const parent = path.dirname(currentDir);
      if (parent === currentDir) break;
      currentDir = parent;
    }

    throw new Error(
      'Unable to locate ProjectMind runtime installation.\n' +
      'Please ensure ProjectMind is installed globally, or set the PROJECTMIND_HOME environment variable to the ProjectMind installation directory.'
    );
  }

  private static findSdkInRoot(rootDir: string): string | null {
    const candidates = [
      path.join(rootDir, 'packages', 'agent-sdk', 'dist', 'index.js'),
      path.join(rootDir, 'node_modules', '@projectmind', 'agent-sdk', 'dist', 'index.js'),
      path.join(rootDir, 'node_modules', '@projectmind', 'agent-sdk', 'index.js'),
      path.join(rootDir, 'dist', 'packages', 'agent-sdk', 'index.js'),
      path.join(rootDir, 'dist', 'agent-sdk.js')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  private static findMcpInRoot(rootDir: string): string | null {
    const candidates = [
      path.join(rootDir, 'packages', 'mcp-server', 'dist', 'cli.js'),
      path.join(rootDir, 'node_modules', '@projectmind', 'mcp-server', 'dist', 'cli.js'),
      path.join(rootDir, 'node_modules', '@projectmind', 'mcp-server', 'cli.js'),
      path.join(rootDir, 'dist', 'packages', 'mcp-server', 'cli.js'),
      path.join(rootDir, 'dist', 'mcp-server-cli.js')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  private static searchProjectMindRoot(startDir: string): string {
    let curr = path.resolve(startDir);
    while (true) {
      if (fs.existsSync(path.join(curr, 'package.json'))) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(curr, 'package.json'), 'utf8'));
          if (pkg.name === 'projectmind') return curr;
        } catch (_) {}
      }
      const parent = path.dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }
    return startDir;
  }

  /**
   * Resolves the target project root independently.
   * Priority:
   * 1. PROJECTMIND_PROJECT_ROOT
   * 2. Agent-provided root from payload
   * 3. Agent-specific environment variables
   * 4. Current working directory
   * 5. Validated discovery fallback
   */
  public static resolveTargetProjectRoot(options?: TargetProjectRootOptions): string {
    const candidate =
      options?.explicitRoot ||
      process.env.PROJECTMIND_PROJECT_ROOT ||
      options?.payloadRoot ||
      options?.agentEnvRoot ||
      options?.cwd ||
      process.cwd();

    if (!candidate || typeof candidate !== 'string') {
      throw new Error('Target project root candidate is invalid or empty.');
    }

    const resolved = path.resolve(candidate);
    let realRoot = resolved;
    if (fs.existsSync(resolved)) {
      try {
        realRoot = fs.realpathSync(resolved);
      } catch (_) {
        realRoot = resolved;
      }
    }

    // Safety guard: prevent accidental initialization of ProjectMind's own repository
    // unless allowSelfRoot is explicitly permitted
    if (!options?.allowSelfRoot && !options?.explicitRoot && !process.env.PROJECTMIND_PROJECT_ROOT) {
      try {
        const pkgJson = path.join(realRoot, 'package.json');
        if (fs.existsSync(pkgJson)) {
          const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
          if (pkg.name === 'projectmind' && pkg.description?.includes('Universal Local-First AI Project Intelligence')) {
            const callerCwd = process.cwd();
            if (path.resolve(callerCwd) !== path.resolve(realRoot)) {
              return path.resolve(callerCwd);
            }
          }
        }
      } catch (_) {}
    }

    return realRoot;
  }
}

