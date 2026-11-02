import 'pixi.js/unsafe-eval';
import { Live2DPerformancePreview } from '../../engine/Live2DPerformancePreview';
import { initLive2DRuntimeAvailability } from '../../engine/Live2DRuntimeAvailability';
import { isPreviewRequest, type PreviewResponse } from './previewProtocol';
import './previewFrame.css';

initLive2DRuntimeAvailability();
let preview: Live2DPerformancePreview | null = null;
let modelUrl = '';
const reply = (message: PreviewResponse) => window.parent.postMessage(message, '*');

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || !isPreviewRequest(event.data)) return;
  const request = event.data;
  if (!preview || modelUrl !== request.modelUrl) {
    preview?.dispose();
    modelUrl = request.modelUrl;
    preview = new Live2DPerformancePreview(document.body, modelUrl);
  }
  void preview.play(request.kind, request.key).then(
    () => reply({ type: 'live2d-preview:played', requestId: request.requestId }),
    (error: unknown) => reply({ type: 'live2d-preview:error', requestId: request.requestId,
      message: error instanceof Error ? error.message : '预览失败，请重试。' }),
  );
});
window.addEventListener('pagehide', () => preview?.dispose(), { once: true });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') reply({ type: 'live2d-preview:close' });
});
reply({ type: 'live2d-preview:ready' });
