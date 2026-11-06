import * as path from 'path';
import {
  CoreMemoryRecord,
  ModuleKnowledgeRecord,
  KnowledgeItemRecord,
  ArchitecturalDecisionRecord,
  MEMORY_SCHEMA_VERSION,
  computeSha256,
  sanitizeUntrustedContent
} from '@projectmind/shared';
import { ProjectMemoryStore } from '@projectmind/storage';
import { ProjectIdentityManager } from '@projectmind/core';

export interface PromptSpecificationInput {
  projectName?: string;
  promptText: string;
  requirements?: string[];
  techStack?: {
    languages?: string[];
    frameworks?: string[];
    database?: string[];
    packageManager?: string;
  };
  constraints?: string[];
  plannedModules?: Array<{ name: string; purpose: string; rootPath?: string }>;
}

export interface PromptInitializationResult {
  projectId: string;
  projectName: string;
  status: 'planned_from_prompt';
  extractedPurpose: string;
  extractedRequirements: string[];
  extractedFeatures: string[];
  extractedUserRoles: string[];
  extractedDatabaseRequirements: string[];
  extractedApiRequirements: string[];
  extractedConstraints: string[];
  unresolvedQuestions: string[];
  plannedModules: string[];
}

export class KnowledgeEngine {
  private readonly projectRoot: string;
  private readonly store: ProjectMemoryStore;

  constructor(projectRoot: string, store: ProjectMemoryStore) {
    this.projectRoot = path.resolve(projectRoot);
    this.store = store;
  }

  public initializeFromPrompt(spec: PromptSpecificationInput): PromptInitializationResult {
    const { projectId } = ProjectIdentityManager.getOrCreateProjectId(this.projectRoot);
    const { sanitized } = sanitizeUntrustedContent(spec.promptText);
    const lines = sanitized.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    const projectName = spec.projectName || path.basename(this.projectRoot) || 'new-project';
    const extractedPurpose = lines[0]?.replace(/^#+\s*/, '').slice(0, 280) || `Planned project ${projectName}`;

    const extractedRequirements: string[] = [...(spec.requirements || [])];
    const extractedFeatures: string[] = [];
    const extractedUserRoles: string[] = [];
    const extractedDatabaseRequirements: string[] = [];
    const extractedApiRequirements: string[] = [];
    const extractedConstraints: string[] = [...(spec.constraints || [])];
    const unresolvedQuestions: string[] = [];
    const inferredLangs = new Set<string>(spec.techStack?.languages || []);
    const inferredFrameworks = new Set<string>(spec.techStack?.frameworks || []);
    const inferredDbs = new Set<string>(spec.techStack?.database || []);

    for (const line of lines) {
      const clean = line.replace(/^[-*0-9.)]+\s*/, '');
      if (/\b(typescript|ts)\b/i.test(clean)) inferredLangs.add('TypeScript');
      if (/\b(python|fastapi|django|flask)\b/i.test(clean)) inferredLangs.add('Python');
      if (/\b(go|golang)\b/i.test(clean)) inferredLangs.add('Go');
      if (/\b(rust)\b/i.test(clean)) inferredLangs.add('Rust');
      if (/\b(react|next\.?js|express|fastify|nestjs|fastapi)\b/i.test(clean)) {
        const m = clean.match(/\b(React|Next\.?js|Express|Fastify|NestJS|FastAPI)\b/i);
        if (m) inferredFrameworks.add(m[1]);
      }
      if (/\b(postgres|postgresql|sqlite|mysql|mongodb|redis|prisma)\b/i.test(clean)) {
        const m = clean.match(/\b(PostgreSQL|Postgres|SQLite|MySQL|MongoDB|Redis|Prisma)\b/i);
        if (m) inferredDbs.add(m[1]);
      }
      if (/\b(must|shall|require|need to|support)\b/i.test(clean)) extractedRequirements.push(clean);
      if (/\b(feature|allow users to|capability|workflow|dashboard|authentication|billing|notification|search)\b/i.test(clean)) extractedFeatures.push(clean);
      if (/\b(admin|administrator|customer|developer|guest|member|operator|tenant|user role|moderator)\b/i.test(clean)) extractedUserRoles.push(clean);
      if (/\b(table|schema|database|model|entity|migration|store|foreign key)\b/i.test(clean)) extractedDatabaseRequirements.push(clean);
      if (/\b(api|endpoint|route|rest|graphql|webhook|get|post|put|delete|rpc)\b/i.test(clean)) extractedApiRequirements.push(clean);
      if (/\b(constraint|never|must not|limit|budget|offline|security|privacy|latency)\b/i.test(clean)) extractedConstraints.push(clean);
      if (clean.endsWith('?') || /\b(tbd|todo|unclear|decide later|open question)\b/i.test(clean)) unresolvedQuestions.push(clean);
    }

    if (unresolvedQuestions.length === 0) {
      unresolvedQuestions.push('Verify final authentication & deployment configuration once initial modules are implemented.');
    }

    const plannedModulesInput = spec.plannedModules && spec.plannedModules.length > 0
      ? spec.plannedModules
      : this.inferPlannedModulesFromPrompt(sanitized);

    const now = new Date().toISOString();
    const coreMemory: CoreMemoryRecord = {
      projectId,
      projectName,
      projectRoot: this.projectRoot,
      previousRoots: [],
      mainTechStack: {
        languages: Array.from(inferredLangs),
        frameworks: Array.from(inferredFrameworks),
        packageManager: spec.techStack?.packageManager || 'npm',
        database: Array.from(inferredDbs)
      },
      projectPurpose: extractedPurpose,
      keyConstraints: Array.from(new Set(extractedConstraints)).slice(0, 12),
      architecturalSummary: `[PLANNED ARCHITECTURE] ${extractedPurpose}. Planned modules: ${plannedModulesInput.map((m) => m.name).join(', ')}.`,
      currentState: 'planned_from_prompt',
      memorySchemaVersion: MEMORY_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now
    };
    this.store.saveCoreMemory(coreMemory);

    const moduleRecords: ModuleKnowledgeRecord[] = plannedModulesInput.map((pm) => ({
      moduleId: pm.rootPath || `src/${pm.name}`,
      name: pm.name,
      rootPath: pm.rootPath || `src/${pm.name}`,
      purpose: `[PLANNED] ${pm.purpose}`,
      entryFiles: [],
      fileCount: 0,
      publicSymbols: [],
      dependencies: [],
      dependents: [],
      routes: [],
      models: [],
      verificationStatus: 'planned',
      confidence: 0.75,
      lastVerifiedAt: now,
      fingerprint: computeSha256(`planned:${pm.name}:${pm.purpose}`)
    }));
    this.store.upsertModulesBatch(moduleRecords);

    const knowledgeItems: KnowledgeItemRecord[] = [
      {
        knowledgeId: 'planned_requirements',
        category: 'requirement',
        title: 'Planned Project Requirements & Features',
        summary: Array.from(new Set([...extractedRequirements, ...extractedFeatures])).slice(0, 6).join('; ') || extractedPurpose,
        details: {
          requirements: Array.from(new Set(extractedRequirements)),
          features: Array.from(new Set(extractedFeatures)),
          userRoles: Array.from(new Set(extractedUserRoles))
        },
        sourceFiles: [],
        relatedModules: moduleRecords.map((m) => m.moduleId),
        verificationStatus: 'planned',
        confidence: 0.8,
        version: 1,
        lastVerifiedAt: now
      },
      {
        knowledgeId: 'planned_database_schema',
        category: 'database_schema',
        title: 'Planned Database & Persistence Requirements',
        summary: extractedDatabaseRequirements.slice(0, 5).join('; ') || 'Planned data persistence layer',
        details: { databaseRequirements: extractedDatabaseRequirements, databases: Array.from(inferredDbs) },
        sourceFiles: [],
        relatedModules: moduleRecords.map((m) => m.moduleId),
        verificationStatus: 'planned',
        confidence: 0.75,
        version: 1,
        lastVerifiedAt: now
      },
      {
        knowledgeId: 'planned_api_surface',
        category: 'api',
        title: 'Planned API & Route Requirements',
        summary: extractedApiRequirements.slice(0, 5).join('; ') || 'Planned API surface',
        details: { apiRequirements: extractedApiRequirements },
        sourceFiles: [],
        relatedModules: moduleRecords.map((m) => m.moduleId),
        verificationStatus: 'planned',
        confidence: 0.75,
        version: 1,
        lastVerifiedAt: now
      },
      {
        knowledgeId: 'planned_unresolved_questions',
        category: 'unresolved_question',
        title: 'Unresolved Specification Questions',
        summary: unresolvedQuestions.join('; '),
        details: { questions: unresolvedQuestions },
        sourceFiles: [],
        relatedModules: ['root'],
        verificationStatus: 'unverified',
        confidence: 0.5,
        version: 1,
        lastVerifiedAt: now
      }
    ];
    this.store.upsertKnowledgeItemsBatch(knowledgeItems);

    this.store.recordSyncEvent({
      eventType: 'prompt_init',
      changedFiles: [],
      deletedFiles: [],
      renamedFiles: [],
      affectedModules: moduleRecords.map((m) => m.moduleId),
      summary: `Initialized planned project knowledge from specification with ${moduleRecords.length} planned module(s).`
    });

    return {
      projectId,
      projectName,
      status: 'planned_from_prompt',
      extractedPurpose,
      extractedRequirements: Array.from(new Set(extractedRequirements)),
      extractedFeatures: Array.from(new Set(extractedFeatures)),
      extractedUserRoles: Array.from(new Set(extractedUserRoles)),
      extractedDatabaseRequirements: Array.from(new Set(extractedDatabaseRequirements)),
      extractedApiRequirements: Array.from(new Set(extractedApiRequirements)),
      extractedConstraints: coreMemory.keyConstraints,
      unresolvedQuestions,
      plannedModules: moduleRecords.map((m) => m.moduleId)
    };
  }

  private inferPlannedModulesFromPrompt(promptText: string): Array<{ name: string; purpose: string; rootPath: string }> {
    const candidates: Array<{ keyword: RegExp; name: string; purpose: string }> = [
      { keyword: /\b(auth|login|jwt|oauth|session|permission)\b/i, name: 'auth', purpose: 'Authentication, authorization, and session management' },
      { keyword: /\b(user|profile|account|role|tenant)\b/i, name: 'users', purpose: 'User accounts, roles, and profile management' },
      { keyword: /\b(db|database|prisma|sql|model|schema|repository|storage)\b/i, name: 'database', purpose: 'Database models, schema migrations, and repositories' },
      { keyword: /\b(api|route|endpoint|controller|rest|graphql)\b/i, name: 'api', purpose: 'API routes, request validation, and controllers' },
      { keyword: /\b(billing|payment|stripe|subscription|invoice)\b/i, name: 'billing', purpose: 'Billing, subscriptions, and payment processing' },
      { keyword: /\b(ui|frontend|component|page|dashboard|view)\b/i, name: 'ui', purpose: 'User interface components and views' }
    ];
    const matched = candidates
      .filter((c) => c.keyword.test(promptText))
      .map((c) => ({ name: c.name, purpose: c.purpose, rootPath: `src/${c.name}` }));

    if (matched.length === 0) {
      return [
        { name: 'core', purpose: 'Core domain logic and services', rootPath: 'src/core' },
        { name: 'api', purpose: 'Application entrypoints and interfaces', rootPath: 'src/api' }
      ];
    }
    return matched;
  }

  public recordArchitecturalDecision(input: {
    title: string;
    context: string;
    decision: string;
    consequences?: string[];
    constraints?: string[];
    relatedModules?: string[];
    sourceReferences?: string[];
    verificationStatus?: 'verified' | 'planned' | 'inferred';
  }): ArchitecturalDecisionRecord {
    const decisionId = `adr_${computeSha256(`${input.title}:${Date.now()}`).slice(0, 12)}`;
    const record: ArchitecturalDecisionRecord = {
      decisionId,
      title: input.title,
      context: input.context,
      decision: input.decision,
      consequences: input.consequences || [],
      constraints: input.constraints || [],
      relatedModules: input.relatedModules || ['root'],
      sourceReferences: input.sourceReferences || [],
      verificationStatus: input.verificationStatus || 'verified',
      recordedAt: new Date().toISOString()
    };
    this.store.upsertDecision(record);
    this.store.invalidateCacheForModules(record.relatedModules);
    return record;
  }
}
