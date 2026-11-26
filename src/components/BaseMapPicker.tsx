import React, { useEffect, useState } from 'react';
import { Button } from 'antd';
import { AmapStyle } from '../types';
import DraggableModal from './DraggableModal';
import {
  CUSTOM_AMAP_CHANGED_EVENT,
  hasConfiguredCustomAmapKey,
  isCustomAmapActive,
  setCustomAmapEngineEnabled
} from '../lib/amapCustomConfig';

const styles: { value: AmapStyle; zh: string; en: string; hint: string; hintEn: string }[] = [
  { value: 'normal', zh: '标准', en: 'Standard', hint: '信息完整，方便定位', hintEn: 'Detailed geography' },
  { value: 'grey', zh: '灰色', en: 'Grey', hint: '底图淡化，突出线路', hintEn: 'Keep your lines in focus' },
  { value: 'dark', zh: '深色', en: 'Dark', hint: '深色背景，衬托亮色线路', hintEn: 'For bright line colors' },
  { value: 'fresh', zh: '清新', en: 'Fresh', hint: '色彩柔和，适合日常绘制', hintEn: 'Soft everyday colors' }
];

interface BaseMapPickerProps {
  initialStyle: AmapStyle;
  language: 'zh-CN' | 'en-US';
  hasContent: boolean;
  onCancel: () => void;
  onConfirm: (style: AmapStyle) => void;
  onOpenAmapSettings?: () => void;
}

const BaseMapPicker: React.FC<BaseMapPickerProps> = ({
  initialStyle,
  language,
  hasContent,
  onCancel,
  onConfirm,
  onOpenAmapSettings
}) => {
  const [selected, setSelected] = useState(initialStyle);
  const [amapActive, setAmapActive] = useState(() => isCustomAmapActive());
  const [hasKey, setHasKey] = useState(() => hasConfiguredCustomAmapKey());
  useEffect(() => {
    const sync = () => {
      setAmapActive(isCustomAmapActive());
      setHasKey(hasConfiguredCustomAmapKey());
    };
    window.addEventListener(CUSTOM_AMAP_CHANGED_EVENT, sync);
    return () => window.removeEventListener(CUSTOM_AMAP_CHANGED_EVENT, sync);
  }, []);
  const en = language === 'en-US';
  return (
    <DraggableModal open title={en ? 'Choose a basemap style' : '选择底图风格'}
      onCancel={onCancel} width={580} className="metro-basemap-picker" wrapClassName="metro-basemap-wrap"
      footer={<><Button onClick={onCancel}>{en ? 'Cancel' : '取消'}</Button>
        <Button type="primary" onClick={() => onConfirm(selected)}>{en ? 'Start drawing' : '开始绘制'}</Button></>}>
      <p className="metro-basemap-intro">{en ? 'Choose a look. You can change it in Settings → Map.' : '选一种喜欢的风格，之后可在“设置 → 地图”中切换。'}</p>
      {hasContent && <p className="metro-basemap-intro">{en ? 'Existing lines and stations will automatically map onto the city view and scale with the map.' : '当前画布线网将自动映射到所选地图视野并跟随底图平移缩放，也可框选整片拖动对齐。'}</p>}
      <div className="metro-basemap-options" role="radiogroup" aria-label={en ? 'Basemap style' : '底图风格'}>
        {styles.map(style => <label key={style.value} className={`metro-basemap-option${selected === style.value ? ' is-selected' : ''}`}>
          <img src={`${process.env.PUBLIC_URL}/map-previews/${style.value}.png`} alt="" width={400} height={256} />
          <span className="metro-basemap-option__label"><input type="radio" name="amap-style" value={style.value}
            checked={selected === style.value} onChange={() => setSelected(style.value)} />{en ? style.en : style.zh}</span>
          <span className="metro-basemap-option__hint">{en ? style.hintEn : style.hint}</span>
        </label>)}
      </div>
      <div
        style={{
          marginTop: 12,
          padding: '8px 12px',
          borderRadius: 10,
          background: 'var(--color-surface-subtle, #f8fafc)',
          border: '1px solid var(--color-border, #e2e8f0)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
          fontSize: 12.5
        }}
      >
        <span>
          {amapActive
            ? '当前渲染引擎：高德矢量底图（自有 Key 已启用）'
            : '当前渲染引擎：内置免配置公开瓦片（OpenStreetMap / CARTO）'}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          {hasKey ? (
            <Button
              size="small"
              onClick={() => setCustomAmapEngineEnabled(!amapActive)}
            >
              {amapActive ? '切回内置瓦片' : '一键切至高德底图'}
            </Button>
          ) : null}
          {onOpenAmapSettings ? (
            <Button size="small" type="primary" ghost onClick={onOpenAmapSettings}>
              {hasKey ? '修改高德 Key' : '配置个人高德 Key（更清晰）'}
            </Button>
          ) : null}
        </div>
      </div>
    </DraggableModal>
  );
};

export default BaseMapPicker;
