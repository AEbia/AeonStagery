import { SearchableSelect, type SearchableSelectProps } from '../../SearchableSelect';

export function resolveCharacterModelHints(
  charId: string | undefined,
  charMeta: { id?: string; name?: string; model?: string } | undefined,
  targetModelPath: string | undefined,
): { preferredGroup?: string } {
  const rawPath = targetModelPath || charMeta?.model || '';
  const modelPath = rawPath.replace(/\\/g, '/');

  let preferredGroup: string | undefined;

  // 1. Try to extract band/char from modelPath, e.g. .../figure/mygo/anon/live_01/...
  const figureMatch = modelPath.match(/(?:figure|models?|live2d)\/([^/]+)\/([^/]+)/i);
  if (figureMatch) {
    preferredGroup = `${figureMatch[1]}/${figureMatch[2]}`;
  }

  // 2. If no preferredGroup from path pattern, check if charId or name is available
  if (!preferredGroup && charId) {
    preferredGroup = charId;
  }

  return { preferredGroup };
}

interface Live2DResourceSelectProps extends SearchableSelectProps {
  charId?: string;
  character?: { id?: string; name?: string; model?: string };
  modelPath?: string;
}

export function Live2DResourceSelect({ charId, character, modelPath, ...props }: Live2DResourceSelectProps) {
  const hints = resolveCharacterModelHints(charId, character, modelPath);
  return (
    <div className="live2d-resource-select">
      <SearchableSelect
        {...props}
        {...hints}
        header={character ? `角色: ${character.name || character.id}` : undefined}
      />
    </div>
  );
}
