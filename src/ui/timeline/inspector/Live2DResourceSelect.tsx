import { useEffect, useRef, useState } from 'react';
import { SearchableSelect, type SearchableSelectProps } from '../../SearchableSelect';
import { Live2DResourcePreview } from '../../live2d/Live2DResourcePreview';
import type { Live2DPerformanceKind } from '../../../engine/runtime/Live2DRuntimeContracts';

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

interface Live2DResourceSelectProps extends Omit<SearchableSelectProps, 'onPreview'> {
  charId?: string;
  character?: { id?: string; name?: string; model?: string };
  modelPath?: string;
  kind: Live2DPerformanceKind;
}

export function Live2DResourceSelect({ charId, character, modelPath, kind, ...props }: Live2DResourceSelectProps) {
  const [preview, setPreview] = useState<{ key: string; modelPath: string; playbackId: number } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const previewModelPath = modelPath || character?.model;
  useEffect(() => { setPreview(null); setPreviewOpen(false); }, [previewModelPath, kind, charId]);
  const closePreview = () => {
    setPreviewOpen(false);
    if (previewRef.current?.contains(document.activeElement)) {
      pickerRef.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus({ preventScroll: true });
    }
  };
  const hints = resolveCharacterModelHints(charId, character, modelPath);
  return (
    <div ref={pickerRef} className="live2d-resource-select">
      <SearchableSelect
        {...props}
        {...hints}
        header={character ? `角色: ${character.name || character.id}` : undefined}
        additionalInsideRefs={[...(props.additionalInsideRefs ?? []), previewRef]}
        onOpenChange={(open) => {
          if (!open) closePreview();
          props.onOpenChange?.(open);
        }}
        onChange={(value) => { closePreview(); props.onChange(value); }}
        onPreview={previewModelPath ? (key) => {
          setPreviewOpen(true);
          setPreview((previous) => ({
            key, modelPath: previewModelPath, playbackId: (previous?.playbackId ?? 0) + 1,
          }));
        } : undefined}
      />
      {preview && preview.modelPath === previewModelPath && <Live2DResourcePreview
        key={preview.modelPath} modelPath={preview.modelPath} kind={kind} resourceKey={preview.key} playbackId={preview.playbackId}
        anchorRef={pickerRef} panelRef={previewRef} open={previewOpen}
        characterName={character?.name || charId} onClose={closePreview} onExited={() => setPreview(null)}
      />}
    </div>
  );
}
