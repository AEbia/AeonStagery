import type { AgentDialogueStyleCatalog } from '../../api/types/project-agent';
import type { ProjectTemplateConfiguration } from '../../api/types/project';
import type { LoadedTemplatePackage } from '../template-package/TemplatePackageManifest';
import { createTemplatePackageView } from '../template-package/TemplatePackageLoader';

/** Use the same enabled-package precedence as project style materialization. */
export function describeProjectAgentDialogueStyles(
  templates: ProjectTemplateConfiguration | undefined,
  packages: readonly LoadedTemplatePackage[] = [],
): AgentDialogueStyleCatalog {
  const view = createTemplatePackageView([...packages], {
    enabledTemplateIds: templates?.enabledTemplateIds ?? [],
  });
  const snapshot = templates?.dialoguePresentation;
  const defaultStyleId = templates?.defaults?.dialogueStyleId
    ?? snapshot?.styleId ?? view.defaults.dialogueStyleId ?? templates?.dialogueTemplate ?? 'glass';
  const styles = new Map<string, AgentDialogueStyleCatalog['availableStyles'][number]>();
  for (const [id, name] of [['glass', '玻璃'], ['minimal', '极简'], ['classic', '经典']]) {
    styles.set(id, { id, name, renderer: id, materializationRequired: false });
  }
  for (const style of view.dialogueStyles) {
    styles.set(style.id, {
      id: style.id,
      name: style.name,
      renderer: style.renderer,
      materializationRequired: style.renderer === 'image-dialogue-v1' && snapshot?.styleId !== style.id,
    });
  }
  if (snapshot?.styleId && !styles.has(snapshot.styleId)) {
    styles.set(snapshot.styleId, {
      id: snapshot.styleId, name: snapshot.styleId, renderer: snapshot.renderer, materializationRequired: false,
    });
  }
  return { defaultStyleId, availableStyles: [...styles.values()] };
}
