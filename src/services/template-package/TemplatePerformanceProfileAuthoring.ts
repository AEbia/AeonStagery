import type { IFileAccess } from '../io/IFileAccess';
import { PERFORMANCE_PROFILE_SCHEMA_VERSION } from '../ai-authoring/performance/PerformanceProfileTypes';
import { parsePerformanceProfileDocument } from '../ai-authoring/performance/PerformanceProfileValidation';
import type {
  PerformanceProfileCharacterV1,
  PerformanceProfileDocumentV1,
  PerformanceProfileKeyEntryV1,
} from '../ai-authoring/performance/PerformanceProfileTypes';
import type {
  LoadedTemplatePackage,
} from './TemplatePackageManifest';
import {
  parseTemplatePackageManifest,
} from './TemplatePackageManifest';
import {
  TEMPLATE_PACKAGE_MANIFEST_FILE,
  createTemplatePackageView,
} from './TemplatePackageLoader';
import type { TemplatePackageCatalog } from './TemplatePackageCatalog';

export type PerformanceProfileEntryKind = 'motions' | 'expressions';

export interface EditablePerformanceProfileTarget {
  readonly templateId: string;
  readonly templateName: string;
  readonly templateVersion: string;
  readonly profileId: string;
  readonly profileName: string;
  readonly profile: PerformanceProfileDocumentV1;
  readonly editable: boolean;
  readonly readOnlyReason?: string;
}

export interface PerformanceProfileTemplateDraft {
  readonly templateId: string;
  readonly templateName: string;
  readonly profileId: string;
  readonly profileName: string;
  readonly characters: readonly PerformanceProfileCharacterV1[];
}

export interface SavePerformanceProfileTemplateInput {
  readonly draft: PerformanceProfileTemplateDraft;
  readonly originalTemplateId?: string;
  readonly originalProfileId?: string;
  readonly expectedProfileFingerprint?: string;
}

export interface SavePerformanceProfileTemplateResult {
  readonly templateId: string;
  readonly profileId: string;
  readonly draft: PerformanceProfileTemplateDraft;
}

export interface TemplatePerformanceProfileAuthoringOptions {
  readonly getAuthoringRoot?: () => Promise<string | null>;
}

type JsonRecord = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeEntry(entry: PerformanceProfileKeyEntryV1): PerformanceProfileKeyEntryV1 {
  const key = entry.key.trim();
  const description = entry.description?.trim();
  return description ? { key, description } : { key };
}

function normalizeCharacter(character: PerformanceProfileCharacterV1): PerformanceProfileCharacterV1 {
  const aliases = [...new Set((character.aliases ?? []).map((alias) => alias.trim()).filter(Boolean))];
  const motions = (character.motions ?? []).map(normalizeEntry);
  const expressions = (character.expressions ?? []).map(normalizeEntry);
  return {
    id: character.id.trim(),
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(motions.length > 0 ? { motions } : {}),
    ...(expressions.length > 0 ? { expressions } : {}),
  };
}

function normalizeDraft(draft: PerformanceProfileTemplateDraft): PerformanceProfileTemplateDraft {
  return {
    templateId: draft.templateId.trim(),
    templateName: draft.templateName.trim(),
    profileId: draft.profileId.trim(),
    profileName: draft.profileName.trim(),
    characters: draft.characters.map(normalizeCharacter),
  };
}

function assertSafeId(value: string, label: string): void {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label}只能使用字母、数字、点、下划线和连字符，并且必须以字母或数字开头。`);
  }
}

function profileFingerprint(profile: PerformanceProfileDocumentV1): string {
  return JSON.stringify(profile);
}

export class TemplatePerformanceProfileAuthoringService {
  constructor(
    private readonly fileAccess: IFileAccess,
    private readonly catalog: TemplatePackageCatalog,
    private readonly options: TemplatePerformanceProfileAuthoringOptions = {},
  ) {}

  listTargets(packages: readonly LoadedTemplatePackage[] = this.catalog.getPackages()): EditablePerformanceProfileTarget[] {
    const effectivePackages = createTemplatePackageView([...packages]).packages;
    const templateIds = [...new Set(effectivePackages.map((templatePackage) => templatePackage.manifest.template.id))];
    const editable = typeof this.fileAccess.replaceFile === 'function'
      && typeof this.options.getAuthoringRoot === 'function';
    return templateIds.flatMap((templateId) => {
      const view = createTemplatePackageView([...packages], { enabledTemplateIds: [templateId] });
      const effectiveTemplatePackage = view.packages.find((candidate) => (
        candidate.manifest.template.id === templateId
      ));
      return view.performanceProfiles.flatMap((profile) => {
        if (profile.source.templateId !== templateId) return [];
        return [{
          templateId,
          templateName: effectiveTemplatePackage?.manifest.template.name ?? profile.source.templateName,
          templateVersion: effectiveTemplatePackage?.manifest.template.version ?? '1.0.0',
          profileId: profile.id,
          profileName: profile.name,
          profile: {
            schemaVersion: profile.schemaVersion,
            id: profile.id,
            name: profile.name,
            characters: clone(profile.characters),
          },
          editable,
          ...(!editable ? { readOnlyReason: 'AI 表演模板编辑仅在桌面应用中可用。' } : {}),
        } satisfies EditablePerformanceProfileTarget];
      });
    });
  }

  createDraft(target: EditablePerformanceProfileTarget): PerformanceProfileTemplateDraft {
    return {
      templateId: target.templateId,
      templateName: target.templateName,
      profileId: target.profileId,
      profileName: target.profileName,
      characters: clone(target.profile.characters),
    };
  }

  createEmptyDraft(suggestedName = '新表演模板'): PerformanceProfileTemplateDraft {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const templateId = `performance.custom.${suffix}`;
    return {
      templateId,
      templateName: suggestedName,
      profileId: `${templateId}.profile`,
      profileName: suggestedName,
      characters: [],
    };
  }

  async saveTemplate(input: SavePerformanceProfileTemplateInput): Promise<SavePerformanceProfileTemplateResult> {
    if (!this.fileAccess.replaceFile || !this.options.getAuthoringRoot) {
      throw new Error('AI 表演模板编辑仅在桌面应用中可用。');
    }

    const draft = normalizeDraft(input.draft);
    assertSafeId(draft.templateId, '模板 ID');
    assertSafeId(draft.profileId, 'Profile ID');
    if (!draft.templateName) throw new Error('模板名称不能为空。');
    if (!draft.profileName) throw new Error('Profile 名称不能为空。');

    const parsedProfile = parsePerformanceProfileDocument({
      schemaVersion: PERFORMANCE_PROFILE_SCHEMA_VERSION,
      id: draft.profileId,
      name: draft.profileName,
      characters: draft.characters,
    });

    this.assertTemplateIdentityAvailable(input, draft);
    this.assertSourceUnchanged(input);

    const sourceTemplate = input.originalTemplateId
      ? this.getEffectiveTemplatePackage(input.originalTemplateId)
      : undefined;
    const destination = await this.resolveDestination(draft.templateId, sourceTemplate);
    const { packageRoot, manifestPath } = destination;
    await this.fileAccess.ensureDir(packageRoot);

    const existingManifest = await this.readAuthoredManifest(manifestPath);
    const manifest = this.buildManifest(existingManifest, sourceTemplate, draft, parsedProfile, input.originalProfileId);
    parseTemplatePackageManifest(manifest);
    await this.writeAtomically(manifestPath, JSON.stringify(manifest, null, 2));
    await this.catalog.refresh();

    return {
      templateId: draft.templateId,
      profileId: draft.profileId,
      draft: {
        ...draft,
        characters: clone(parsedProfile.characters),
      },
    };
  }

  private getEffectiveTemplatePackage(templateId: string): LoadedTemplatePackage | undefined {
    return createTemplatePackageView([...this.catalog.getPackages()], {
      enabledTemplateIds: [templateId],
    }).packages.find((candidate) => candidate.manifest.template.id === templateId);
  }

  private async resolveDestination(
    templateId: string,
    sourceTemplate: LoadedTemplatePackage | undefined,
  ): Promise<{ packageRoot: string; manifestPath: string }> {
    if (sourceTemplate?.source.scope === 'project') {
      return {
        packageRoot: sourceTemplate.source.packageRoot,
        manifestPath: sourceTemplate.source.manifestPath
          ?? await this.fileAccess.join(sourceTemplate.source.packageRoot, TEMPLATE_PACKAGE_MANIFEST_FILE),
      };
    }
    const authoringRoot = await this.options.getAuthoringRoot?.();
    if (!authoringRoot) throw new Error('无法定位本机模板库。');
    const templatesRoot = await this.fileAccess.join(authoringRoot, 'templates');
    const packageRoot = await this.fileAccess.join(templatesRoot, templateId);
    return {
      packageRoot,
      manifestPath: await this.fileAccess.join(packageRoot, TEMPLATE_PACKAGE_MANIFEST_FILE),
    };
  }

  private assertTemplateIdentityAvailable(
    input: SavePerformanceProfileTemplateInput,
    draft: PerformanceProfileTemplateDraft,
  ): void {
    if (input.originalTemplateId && draft.templateId !== input.originalTemplateId) {
      throw new Error('已有模板的 ID 不能修改；请新建模板来使用新的 ID。');
    }
    if (input.originalProfileId && draft.profileId !== input.originalProfileId) {
      throw new Error('已有模板的 Profile ID 不能修改；请新建模板来使用新的 ID。');
    }
    if (!input.originalTemplateId && this.catalog.getPackages().some((candidate) => {
      const metadata = candidate.manifest.template;
      return metadata.id === draft.templateId || (metadata.aliases ?? []).includes(draft.templateId)
        || (metadata.id !== draft.templateId && (metadata.aliases ?? []).includes(metadata.id));
    })) {
      throw new Error(`模板 ID “${draft.templateId}” 已存在。`);
    }
  }

  private assertSourceUnchanged(input: SavePerformanceProfileTemplateInput): void {
    if (!input.originalTemplateId || !input.originalProfileId || !input.expectedProfileFingerprint) return;
    const current = this.listTargets().find((target) => (
      target.templateId === input.originalTemplateId
      && target.profileId === input.originalProfileId
    ));
    if (!current) throw new Error('模板已被移除，请重新选择。');
    if (profileFingerprint(current.profile) !== input.expectedProfileFingerprint) {
      throw new Error('模板已在其他位置发生变化，请重新载入后再保存。');
    }
  }

  private async readAuthoredManifest(manifestPath: string): Promise<JsonRecord | null> {
    if (!(await this.fileAccess.exists(manifestPath))) return null;
    const raw = await this.fileAccess.readFile(manifestPath);
    const manifest = JSON.parse(raw.data) as unknown;
    parseTemplatePackageManifest(manifest);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('模板 manifest 必须是对象。');
    }
    return manifest as JsonRecord;
  }

  private buildManifest(
    existing: JsonRecord | null,
    sourceTemplate: LoadedTemplatePackage | undefined,
    draft: PerformanceProfileTemplateDraft,
    profile: PerformanceProfileDocumentV1,
    originalProfileId?: string,
  ): JsonRecord {
    const sourceMetadata = sourceTemplate?.manifest.template;
    const existingTemplate = existing?.template && typeof existing.template === 'object' && !Array.isArray(existing.template)
      ? existing.template as JsonRecord
      : null;
    const existingProfiles = Array.isArray(existing?.performanceProfiles)
      ? existing.performanceProfiles
      : [];
    const performanceProfiles = existingProfiles
      .filter((candidate) => (
        !candidate || typeof candidate !== 'object' || Array.isArray(candidate)
        || (candidate as JsonRecord).id !== (originalProfileId ?? draft.profileId)
      ));
    performanceProfiles.push({
      schemaVersion: PERFORMANCE_PROFILE_SCHEMA_VERSION,
      id: draft.profileId,
      name: draft.profileName,
      characters: clone(profile.characters),
    });
    return {
      ...(existing ?? {}),
      manifestSchemaVersion: 2,
      template: {
        ...(sourceMetadata ?? {}),
        ...(existingTemplate ?? {}),
        id: draft.templateId,
        name: draft.templateName,
        version: typeof existingTemplate?.version === 'string'
          ? existingTemplate.version
          : sourceMetadata?.version ?? '1.0.0',
        category: typeof existingTemplate?.category === 'string'
          ? existingTemplate.category
          : sourceMetadata?.category ?? 'performance',
        compatibility: {
          ...(sourceMetadata?.compatibility ?? {}),
          ...(existingTemplate?.compatibility && typeof existingTemplate.compatibility === 'object' && !Array.isArray(existingTemplate.compatibility)
            ? existingTemplate.compatibility as JsonRecord
            : {}),
          sceneSchemaVersion: 5,
        },
      },
      performanceProfiles,
    };
  }

  private async writeAtomically(destinationPath: string, data: string): Promise<void> {
    if (!this.fileAccess.replaceFile) throw new Error('当前运行环境不支持安全写入模板文件。');
    const temporaryPath = `${destinationPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      await this.fileAccess.writeFile(temporaryPath, `${data}\n`);
      await this.fileAccess.replaceFile(temporaryPath, destinationPath);
    } finally {
      const removeFile = (this.fileAccess as IFileAccess & { removeFile?: (path: string) => Promise<void> }).removeFile;
      await removeFile?.call(this.fileAccess, temporaryPath).catch(() => undefined);
    }
  }
}

export function listPerformanceProfileEntries(
  character: PerformanceProfileCharacterV1,
  kind: PerformanceProfileEntryKind,
): readonly PerformanceProfileKeyEntryV1[] {
  return character[kind] ?? [];
}

export function getPerformanceProfileTargetIdentity(target: EditablePerformanceProfileTarget): string {
  return `${target.templateId}\u0000${target.profileId}`;
}

export function getPerformanceProfileFingerprint(target: EditablePerformanceProfileTarget): string {
  return profileFingerprint(target.profile);
}
