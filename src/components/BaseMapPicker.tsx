import React, { useState } from 'react';
import { Button } from 'antd';
import { AmapStyle } from '../types';
import DraggableModal from './DraggableModal';

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
}

const BaseMapPicker: React.FC<BaseMapPickerProps> = ({ initialStyle, language, hasContent, onCancel, onConfirm }) => {
  const [selected, setSelected] = useState(initialStyle);
  const en = language === 'en-US';
  return (
    <DraggableModal open title={en ? 'Choose a basemap style' : '选择底图风格'}
      onCancel={onCancel} width={580} className="metro-basemap-picker" wrapClassName="metro-basemap-wrap"
      footer={<><Button onClick={onCancel}>{en ? 'Cancel' : '取消'}</Button>
        <Button type="primary" onClick={() => onConfirm(selected)}>{en ? 'Start drawing' : '开始绘制'}</Button></>}>
      <p className="metro-basemap-intro">{en ? 'Choose a look. You can change it in Settings → Map.' : '选一种喜欢的风格，之后可在“设置 → 地图”中切换。'}</p>
      {hasContent && <p className="metro-basemap-intro">{en ? 'Stations with coordinates follow the map. Drag other stations to place them geographically.' : '已有经纬度的站点会贴合底图，其他站点可拖动重新定位。'}</p>}
      <div className="metro-basemap-options" role="radiogroup" aria-label={en ? 'Basemap style' : '底图风格'}>
        {styles.map(style => <label key={style.value} className={`metro-basemap-option${selected === style.value ? ' is-selected' : ''}`}>
          <img src={`${process.env.PUBLIC_URL}/map-previews/${style.value}.png`} alt="" width={400} height={256} />
          <span className="metro-basemap-option__label"><input type="radio" name="amap-style" value={style.value}
            checked={selected === style.value} onChange={() => setSelected(style.value)} />{en ? style.en : style.zh}</span>
          <span className="metro-basemap-option__hint">{en ? style.hintEn : style.hint}</span>
        </label>)}
      </div>
      <p className="metro-basemap-credit">{en ? 'Same location in all previews · © OpenStreetMap · CARTO' : '预览使用同一位置 · © OpenStreetMap · CARTO'}</p>
    </DraggableModal>
  );
};

export default BaseMapPicker;
