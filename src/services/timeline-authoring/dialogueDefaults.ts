import type { ProjectTemplateConfiguration } from '../../api/types/project';
import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import { getSceneDocumentCanonicalOrder, withSceneDocumentCanonicalOrder } from '../semantic-scene/SceneDocumentCanonicalOrder';

export interface DialogueDefaultsReader {
  getDialogueDefaults(): Pick<ProjectTemplateConfiguration, 'dialoguePresentation' | 'dialogueTemplate' | 'defaults'> | undefined;
}

type DialogueDefaultsValue = Pick<ProjectTemplateConfiguration, 'dialoguePresentation' | 'dialogueTemplate' | 'defaults'>;
export type DialogueDefaultsSource = DialogueDefaultsValue | undefined | (() => DialogueDefaultsValue | undefined);

export function applyDialogueDefaultsToCreatedStatements(
  document: CurrentSceneDocument,
  createdStatementIds: readonly string[],
  defaults: DialogueDefaultsSource,
): CurrentSceneDocument {
  if (createdStatementIds.length === 0) return document;
  const createdIds = new Set(createdStatementIds);
  const needsDefault = document.statements.some((statement) => (
    createdIds.has(statement.id)
    && statement.type === 'dialogue'
    && !statement.params.presentation
    && !statement.params.template
  ));
  if (!needsDefault) return document;

  const resolvedDefaults = typeof defaults === 'function' ? defaults() : defaults;
  const styleId = resolvedDefaults?.defaults?.dialogueStyleId;
  const builtin = styleId === 'glass' || styleId === 'minimal' || styleId === 'classic' ? styleId : undefined;
  const presentation = builtin ? undefined : resolvedDefaults?.dialoguePresentation;
  const template = builtin ?? resolvedDefaults?.dialogueTemplate;
  if (!presentation && !template) return document;

  return withSceneDocumentCanonicalOrder({
    ...document,
    statements: document.statements.map((statement) => {
      if (!createdIds.has(statement.id) || statement.type !== 'dialogue'
        || statement.params.presentation || statement.params.template) return statement;
      return {
        ...statement,
        params: {
          ...statement.params,
          ...(presentation ? { presentation: JSON.parse(JSON.stringify(presentation)) } : { template }),
        },
      };
    }),
  }, getSceneDocumentCanonicalOrder(document));
}
