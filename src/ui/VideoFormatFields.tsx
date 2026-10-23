import { FormSelect } from './FormSelect';
import type { ProjectVideoFormat } from '../api/types/video-format';
import './videoFormat.css';

const PRESETS = [
  { value: '1280x720', label: '720p · 1280 × 720' },
  { value: '1920x1080', label: '1080p · 1920 × 1080' },
  { value: '2560x1440', label: '1440p · 2560 × 1440' },
  { value: '3840x2160', label: '4K · 3840 × 2160' },
  { value: '1080x1920', label: '竖屏 · 1080 × 1920' },
  { value: '1080x1080', label: '方形 · 1080 × 1080' },
];

export function VideoFormatFields({ value, onChange, idPrefix, disabled = false }: {
  value: Readonly<ProjectVideoFormat>;
  onChange: (format: ProjectVideoFormat) => void;
  idPrefix: string;
  disabled?: boolean;
}) {
  const preset = `${value.width}x${value.height}`;
  return (
    <fieldset className="video-format" disabled={disabled}>
      <legend className="sr-only">分辨率与帧率</legend>
      <div className="form-group">
        <label className="form-label" htmlFor={`${idPrefix}-preset`}>分辨率预设</label>
        <FormSelect id={`${idPrefix}-preset`} disabled={disabled} value={PRESETS.some(item => item.value === preset) ? preset : 'custom'}
          options={[...PRESETS, { value: 'custom', label: '自定义' }]}
          onChange={selected => {
            if (selected === 'custom') return;
            const [width, height] = selected.split('x').map(Number);
            onChange({ ...value, width, height });
          }} />
      </div>
      <div className="video-format__dimensions">
        {(['width', 'height', 'fps'] as const).map(key => (
          <div className="form-group" key={key}>
            <label className="form-label" htmlFor={`${idPrefix}-${key}`}>{key === 'width' ? '宽度 (px)' : key === 'height' ? '高度 (px)' : '帧率 (fps)'}</label>
            <input className="form-input" id={`${idPrefix}-${key}`} type="number" min={key === 'fps' ? 1 : 16} max={key === 'fps' ? 240 : 8192}
              step={key === 'fps' ? 'any' : 2} value={Number.isNaN(value[key]) ? '' : value[key]}
              onChange={event => onChange({ ...value, [key]: event.target.value === '' ? NaN : Number(event.target.value) })} />
          </div>
        ))}
      </div>
    </fieldset>
  );
}
