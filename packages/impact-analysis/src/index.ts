import { ProjectMemoryStore } from '@projectmind/storage';

export interface ChangeImpactReport {
  targetPathsOrModules: string[];
  directlyAffectedModules: string[];
  transitivelyAffectedModules: string[];
  affectedFiles: string[];
  affectedRoutes: Array<{ method: string; path: string; sourceFile: string }>;
  affectedModels: Array<{ name: string; kind: string; sourceFile: string }>;
  relatedDecisions: Array<{ decisionId: string; title: string; decision: string }>;
  riskLevel: 'low' | 'medium' | 'high';
  recommendsDeepAnalysis: boolean;
  deepAnalysisReasons: string[];
}

export class ImpactAnalyzer {
  private readonly store: ProjectMemoryStore;

  constructor(store: ProjectMemoryStore) {
    this.store = store;
  }

  public findDependencies(moduleOrFile: string): {
    target: string;
    directDependencies: string[];
    transitiveDependencies: string[];
    externalPackages: string[];
  } {
    const modules = this.store.getAllModules();
    const modMap = new Map(modules.map((m) => [m.moduleId, m]));
    let startModId = moduleOrFile;

    if (!modMap.has(startModId)) {
      const byName = modules.find((m) => m.name === moduleOrFile);
      if (byName) startModId = byName.moduleId;
      else {
        const file = this.store.getFile(moduleOrFile);
        if (file) startModId = file.moduleId;
      }
    }

    const startMod = modMap.get(startModId);
    if (!startMod) {
      return { target: moduleOrFile, directDependencies: [], transitiveDependencies: [], externalPackages: [] };
    }

    const directInternal = startMod.dependencies.filter((d) => modMap.has(d));
    const externalPackages = startMod.dependencies.filter((d) => !modMap.has(d));

    const visited = new Set<string>(directInternal);
    const queue = [...directInternal];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const currMod = modMap.get(curr);
      if (!currMod) continue;
      for (const nextDep of currMod.dependencies) {
        if (modMap.has(nextDep) && !visited.has(nextDep) && nextDep !== startModId) {
          visited.add(nextDep);
          queue.push(nextDep);
        }
      }
    }

    return {
      target: startModId,
      directDependencies: directInternal,
      transitiveDependencies: Array.from(visited),
      externalPackages
    };
  }

  public findDependents(moduleOrFile: string): {
    target: string;
    directDependents: string[];
    transitiveDependents: string[];
  } {
    const modules = this.store.getAllModules();
    const modMap = new Map(modules.map((m) => [m.moduleId, m]));
    let startModId = moduleOrFile;

    if (!modMap.has(startModId)) {
      const byName = modules.find((m) => m.name === moduleOrFile);
      if (byName) startModId = byName.moduleId;
      else {
        const file = this.store.getFile(moduleOrFile);
        if (file) startModId = file.moduleId;
      }
    }

    const startMod = modMap.get(startModId);
    if (!startMod) {
      return { target: moduleOrFile, directDependents: [], transitiveDependents: [] };
    }

    const directDependents = [...startMod.dependents];
    const visited = new Set<string>(directDependents);
    const queue = [...directDependents];

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const currMod = modMap.get(curr);
      if (!currMod) continue;
      for (const nextDep of currMod.dependents) {
        if (!visited.has(nextDep) && nextDep !== startModId) {
          visited.add(nextDep);
          queue.push(nextDep);
        }
      }
    }

    return {
      target: startModId,
      directDependents,
      transitiveDependents: Array.from(visited)
    };
  }

  public detectAffectedModules(changedPaths: string[]): {
    directlyAffected: string[];
    transitivelyAffected: string[];
  } {
    const modules = this.store.getAllModules();
    const directSet = new Set<string>();

    for (const p of changedPaths) {
      const normalized = p.replace(/\\/g, '/');
      const exactMod = modules.find((m) => m.moduleId === normalized || m.name === normalized);
      if (exactMod) { directSet.add(exactMod.moduleId); continue; }
      const file = this.store.getFile(normalized);
      if (file) { directSet.add(file.moduleId); continue; }
      const prefixMod = modules.find((m) => m.rootPath !== '.' && normalized.startsWith(m.rootPath + '/'));
      if (prefixMod) directSet.add(prefixMod.moduleId);
      else directSet.add('root');
    }

    const transitiveSet = new Set<string>(directSet);
    for (const modId of directSet) {
      const depInfo = this.findDependents(modId);
      for (const td of depInfo.transitiveDependents) transitiveSet.add(td);
    }

    return {
      directlyAffected: Array.from(directSet),
      transitivelyAffected: Array.from(transitiveSet)
    };
  }

  public analyzeChangeImpact(targetPathsOrModules: string[]): ChangeImpactReport {
    const { directlyAffected, transitivelyAffected } = this.detectAffectedModules(targetPathsOrModules);
    const modules = this.store.getAllModules();
    const affectedSet = new Set(transitivelyAffected);

    const affectedModulesRecords = modules.filter((m) => affectedSet.has(m.moduleId));
    const affectedFiles = this.store.getAllFiles().filter((f) => affectedSet.has(f.moduleId)).map((f) => f.relativePath).slice(0, 40);
    const affectedRoutes = affectedModulesRecords.flatMap((m) => m.routes.map((r) => ({ method: r.method, path: r.path, sourceFile: r.sourceFile })));
    const affectedModels = affectedModulesRecords.flatMap((m) => m.models.map((md) => ({ name: md.name, kind: md.kind, sourceFile: md.sourceFile })));
    const decisions = this.store.getDecisions().filter((d) => d.relatedModules.some((rm) => affectedSet.has(rm) || rm === 'root')).map((d) => ({ decisionId: d.decisionId, title: d.title, decision: d.decision }));

    const deepAnalysisReasons: string[] = [];
    if (transitivelyAffected.length >= 3) {
      deepAnalysisReasons.push(`Change propagates across ${transitivelyAffected.length} modules (${transitivelyAffected.join(', ')}).`);
    }
    if (affectedModels.length > 0) {
      deepAnalysisReasons.push(`Database schema/models (${affectedModels.map((m) => m.name).join(', ')}) are in affected scope.`);
    }
    if (affectedModulesRecords.some((m) => m.verificationStatus !== 'verified')) {
      deepAnalysisReasons.push('One or more affected modules contain unverified or planned knowledge.');
    }

    const riskLevel: ChangeImpactReport['riskLevel'] =
      transitivelyAffected.length >= 4 || affectedModels.length > 0
        ? 'high'
        : transitivelyAffected.length >= 2 || affectedRoutes.length > 0
        ? 'medium'
        : 'low';

    return {
      targetPathsOrModules,
      directlyAffectedModules: directlyAffected,
      transitivelyAffectedModules: transitivelyAffected,
      affectedFiles,
      affectedRoutes,
      affectedModels,
      relatedDecisions: decisions,
      riskLevel,
      recommendsDeepAnalysis: deepAnalysisReasons.length > 0,
      deepAnalysisReasons
    };
  }
}
