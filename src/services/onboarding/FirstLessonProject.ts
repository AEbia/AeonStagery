import type { IProjectOpenWorkflow, ProjectWorkflowResult } from '../../api/interfaces/IProjectOpenWorkflow';
import type { ProjectTemplateConfiguration } from '../../api/types/project';
import type { FirstLessonProgressStore } from './FirstLessonProgress';

export const FIRST_LESSON_PROJECT_NAME = '教程练习';

export interface FirstLessonProjectFileAccess {
  exists(path: string): Promise<boolean>;
  join(...parts: string[]): Promise<string> | string;
}

export interface CreateFirstLessonProjectInput {
  defaultProjectDirectory: string;
  templates?: ProjectTemplateConfiguration;
}

export interface FirstLessonProjectServiceOptions {
  now?: () => Date;
}

export class FirstLessonProjectService {
  private readonly now: () => Date;

  constructor(
    private readonly fileAccess: FirstLessonProjectFileAccess,
    private readonly projectOpenWorkflow: Pick<IProjectOpenWorkflow, 'createProjectAndLoadDefaultScene'>,
    private readonly progressStore?: FirstLessonProgressStore,
    options: FirstLessonProjectServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async createTutorialProject(input: CreateFirstLessonProjectInput): Promise<ProjectWorkflowResult> {
    const rootPath = await createUniqueFirstLessonProjectRoot(
      input.defaultProjectDirectory,
      this.fileAccess,
      this.now(),
    );
    const result = await this.projectOpenWorkflow.createProjectAndLoadDefaultScene({
      name: FIRST_LESSON_PROJECT_NAME,
      rootPath,
      templates: input.templates,
    });

    if (result.success && result.project) {
      this.progressStore?.patch({
        currentStep: 'create-character',
        completed: false,
        hasStartedPreview: false,
        tutorialProjectPath: result.project.rootPath,
      });
    }

    return result;
  }
}

export async function createUniqueFirstLessonProjectRoot(
  defaultProjectDirectory: string,
  fileAccess: FirstLessonProjectFileAccess,
  now: Date = new Date(),
): Promise<string> {
  const parent = normalizeDirectory(defaultProjectDirectory);
  if (!parent) throw new Error('Default project directory is required to create the tutorial project');

  const baseName = `${FIRST_LESSON_PROJECT_NAME}-${formatTimestampForDirectory(now)}`;
  let suffix = 1;
  while (true) {
    const directoryName = suffix === 1 ? baseName : `${baseName}-${suffix}`;
    const candidate = normalizeDirectory(await fileAccess.join(parent, directoryName));
    if (!await fileAccess.exists(candidate)) return candidate;
    suffix += 1;
  }
}

function formatTimestampForDirectory(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function normalizeDirectory(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').trim().replace(/\/+$/, '');
}
