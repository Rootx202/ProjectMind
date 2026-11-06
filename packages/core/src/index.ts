import * as fs from 'fs';
import * as path from 'path';
import {
  ProjectMindConfig,
  DEFAULT_CONFIG,
  DEFAULT_DATA_DIR_NAME,
  computeSha256,
  CoreMemoryRecord
} from '@projectmind/shared';
import { ProjectMemoryStore } from '@projectmind/storage';

const ROOT_MARKERS = [
  '.projectmind', '.git', 'package.json', 'pyproject.toml', 'Cargo.toml',
  'go.mod', 'pom.xml', 'build.gradle', 'requirements.txt', 'Makefile'
];

export class ProjectIdentityManager {
  public static detectProjectRoot(startDir: string): string {
    const resolvedStart = path.resolve(startDir);
    let current = resolvedStart;
    let firstPackageMarker: string | null = null;

    while (true) {
      if (fs.existsSync(path.join(current, DEFAULT_DATA_DIR_NAME))) return current;
      if (fs.existsSync(path.join(current, '.git'))) return current;
      if (!firstPackageMarker) {
        for (const marker of ROOT_MARKERS) {
          if (fs.existsSync(path.join(current, marker))) {
            firstPackageMarker = current;
            break;
          }
        }
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    return firstPackageMarker || resolvedStart;
  }

  public static getOrCreateProjectId(projectRoot: string, dataDirName = DEFAULT_DATA_DIR_NAME): {
    projectId: string;
    movedFrom?: string;
  } {
    const dataDir = path.join(projectRoot, dataDirName);
    fs.mkdirSync(dataDir, { recursive: true });
    const idFilePath = path.join(dataDir, 'project-id.json');

    if (fs.existsSync(idFilePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(idFilePath, 'utf8'));
        const existingId = String(parsed.projectId);
        const lastKnownRoot = String(parsed.projectRoot || projectRoot);
        let movedFrom: string | undefined;
        if (path.resolve(lastKnownRoot) !== path.resolve(projectRoot)) {
          movedFrom = lastKnownRoot;
          parsed.previousRoots = Array.from(new Set([...(parsed.previousRoots || []), lastKnownRoot]));
          parsed.projectRoot = path.resolve(projectRoot);
          parsed.movedAt = new Date().toISOString();
          fs.writeFileSync(idFilePath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
        }
        return { projectId: existingId, movedFrom };
      } catch (_) {}
    }

    const projectName = path.basename(path.resolve(projectRoot));
    const seed = `${projectName}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const projectId = `pm_${computeSha256(seed).slice(0, 16)}`;
    const record = {
      projectId,
      projectName,
      projectRoot: path.resolve(projectRoot),
      previousRoots: [] as string[],
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(idFilePath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    return { projectId };
  }

  public static loadConfig(projectRoot: string, dataDirName = DEFAULT_DATA_DIR_NAME): ProjectMindConfig {
    const configPath = path.join(projectRoot, dataDirName, 'config.json');
    if (!fs.existsSync(configPath)) return { ...DEFAULT_CONFIG, dataDirName };
    try {
      const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return {
        ...DEFAULT_CONFIG,
        ...userConfig,
        dataDirName,
        allowSecretIndexing: false,
        excludePatterns: Array.from(new Set([...DEFAULT_CONFIG.excludePatterns, ...(userConfig.excludePatterns || [])]))
      };
    } catch (_) {
      return { ...DEFAULT_CONFIG, dataDirName };
    }
  }

  public static saveConfig(projectRoot: string, config: Partial<ProjectMindConfig>, dataDirName = DEFAULT_DATA_DIR_NAME): ProjectMindConfig {
    const merged = {
      ...this.loadConfig(projectRoot, dataDirName),
      ...config,
      allowSecretIndexing: false as const
    };
    const dataDir = path.join(projectRoot, dataDirName);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(merged, null, 2) + '\n', 'utf8');
    return merged;
  }

  public static reconcileMovedProject(store: ProjectMemoryStore, currentRoot: string): {
    wasMoved: boolean;
    previousRoot?: string;
    coreMemory: CoreMemoryRecord | null;
  } {
    const core = store.getCoreMemory();
    if (!core) return { wasMoved: false, coreMemory: null };
    const resolvedCurrent = path.resolve(currentRoot);
    const resolvedStored = path.resolve(core.projectRoot);
    if (resolvedCurrent !== resolvedStored) {
      const prev = core.projectRoot;
      const updated: CoreMemoryRecord = {
        ...core,
        projectRoot: resolvedCurrent,
        previousRoots: Array.from(new Set([...(core.previousRoots || []), prev])),
        updatedAt: new Date().toISOString()
      };
      store.saveCoreMemory(updated);
      return { wasMoved: true, previousRoot: prev, coreMemory: updated };
    }
    return { wasMoved: false, coreMemory: core };
  }
}
