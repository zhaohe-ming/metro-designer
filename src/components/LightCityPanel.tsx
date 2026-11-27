import React, { useMemo, useState } from 'react';
import { Button, Input, Slider } from 'antd';
import {
  CheckOutlined,
  DeleteOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import DraggableModal from './DraggableModal';
import ElasticCapsuleTabs from './ElasticCapsuleTabs';
import {
  LightCityArchetype,
  LightCityFeature,
  LightCityLabelKind,
  LightCityRoadKind,
  LightCityZoneKind
} from '../types';
import {
  buildLightCitySvgLayer,
  generateLightCity,
  getLightCityPalette,
  getLightCityPreviewViewBox,
  LIGHT_CITY_ARCHETYPES,
  shouldFeatherLightCityEdges
} from '../lib/lightCity';

export type TerrainTool = 'select' | 'river' | 'waterArea' | 'zone' | 'road' | 'label';

interface PreviewEntry {
  svg: string;
  viewBox: string;
}

const staticRealPreviewCache = new Map<string, PreviewEntry>();

interface LightCityPickerModalProps {
  open: boolean;
  initialArchetype?: LightCityArchetype;
  initialSeed?: number;
  isDark?: boolean;
  language?: 'zh-CN' | 'en-US';
  onCancel: () => void;
  onConfirm: (archetype: LightCityArchetype, seed: number, openSculptImmediately: boolean) => void;
}

export const LightCityPickerModal: React.FC<LightCityPickerModalProps> = ({
  open,
  initialArchetype = 'london',
  initialSeed,
  isDark = false,
  language = 'zh-CN',
  onCancel,
  onConfirm
}) => {
  const [selected, setSelected] = useState<LightCityArchetype>(initialArchetype);
  const [seedBase, setSeedBase] = useState<number>(() => initialSeed || Math.floor(100000 + Math.random() * 899999));
  const isEn = language === 'en-US';
  const pal = getLightCityPalette(isDark);

  const previews = useMemo(() => {
    const map = new Map<LightCityArchetype, PreviewEntry>();
    if (!open) return map;
    LIGHT_CITY_ARCHETYPES.forEach((meta, idx) => {
      if (meta.id === 'custom') {
        map.set(meta.id, { svg: '', viewBox: '-60 -130 1640 1200' });
        return;
      }
      if (shouldFeatherLightCityEdges({ archetype: meta.id })) {
        const cacheKey = `${meta.id}_${isDark ? 1 : 0}_${language}`;
        let cached = staticRealPreviewCache.get(cacheKey);
        if (!cached) {
          const generated = generateLightCity({
            archetype: meta.id,
            seed: 1001 + idx * 17,
            language
          });
          cached = {
            svg: buildLightCitySvgLayer(generated, isDark),
            viewBox: getLightCityPreviewViewBox(generated)
          };
          staticRealPreviewCache.set(cacheKey, cached);
        }
        map.set(meta.id, cached);
        return;
      }
      const generated = generateLightCity({
        archetype: meta.id,
        seed: seedBase + idx * 97,
        language
      });
      map.set(meta.id, {
        svg: buildLightCitySvgLayer(generated, isDark),
        viewBox: getLightCityPreviewViewBox(generated)
      });
    });
    return map;
  }, [open, seedBase, isDark, language]);

  return (
    <DraggableModal
      open={open}
      title={isEn ? 'Choose Light City Basemap' : '选择轻城市底图地貌'}
      onCancel={onCancel}
      width={688}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => setSeedBase(Math.floor(100000 + Math.random() * 899999))}
          >
            {isEn ? 'Shuffle Layouts' : '换一批随机形态'}
          </Button>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={onCancel}>{isEn ? 'Cancel' : '取消'}</Button>
            <Button
              type="primary"
              onClick={() => {
                const idx = Math.max(0, LIGHT_CITY_ARCHETYPES.findIndex((m) => m.id === selected));
                onConfirm(selected, seedBase + idx * 97, selected === 'custom');
              }}
            >
              {selected === 'custom'
                ? isEn
                  ? 'Enter Terrain Sculpt'
                  : '进入手绘造景'
                : isEn
                  ? 'Apply Light City'
                  : '应用此地貌'}
            </Button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--color-text-muted, #64748b)', lineHeight: 1.6 }}>
          {isEn
            ? 'Paper-grey minimalist urban context inspired by Mini Metro. Generated rivers, parks, and boulevards can all be freely reshaped with terrain brushes.'
            : '克制的纸感浅灰底图，仅保留水系、绿地片区、骨干大道与浅水印地名。应用任意模板后，均可点击画布上方「编辑底图」自由增删改河流、洲岛、绿地与街道。'}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(194px, 1fr))',
            gap: 12,
            maxHeight: '62vh',
            overflowY: 'auto',
            paddingRight: 4
          }}
          role="radiogroup"
          aria-label={isEn ? 'Light City Archetypes' : '轻城市地貌原型'}
        >
          {LIGHT_CITY_ARCHETYPES.map((meta) => {
            const active = selected === meta.id;
            const preview = previews.get(meta.id);
            const svgInner = preview?.svg || '';
            const svgViewBox = preview?.viewBox || '-60 -130 1640 1200';
            return (
              <button
                key={meta.id}
                type="button"
                onClick={() => setSelected(meta.id)}
                style={{
                  textAlign: 'left',
                  padding: 10,
                  borderRadius: 14,
                  cursor: 'pointer',
                  color: 'var(--color-text, #0f172a)',
                  border: active ? '2px solid var(--color-primary-500, #2563eb)' : '1px solid var(--color-border, #e2e8f0)',
                  background: active ? 'rgba(59, 130, 246, 0.12)' : 'var(--color-surface-subtle, #f8fafc)',
                  transition: 'border-color 140ms ease, transform 140ms ease'
                }}
              >
                <div
                  style={{
                    width: '100%',
                    height: 104,
                    borderRadius: 10,
                    overflow: 'hidden',
                    border: '1px solid rgba(148, 163, 184, 0.22)',
                    background: pal.canvasBg,
                    marginBottom: 8,
                    display: 'grid',
                    placeItems: 'center'
                  }}
                >
                  {meta.id === 'custom' ? (
                    <span style={{ fontSize: 12, fontWeight: 600, color: isDark ? '#94a3b8' : '#64748b' }}>
                      {isEn ? '+ Freehand Terrain Canvas' : '+ 纯手绘自由造景画布'}
                    </span>
                  ) : (
                    <svg
                      viewBox={svgViewBox}
                      width="100%"
                      height="100%"
                      preserveAspectRatio="xMidYMid slice"
                      aria-hidden="true"
                      dangerouslySetInnerHTML={{ __html: svgInner }}
                    />
                  )}
                </div>
                <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 2 }}>
                  {isEn ? meta.en : meta.zh}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--color-text-muted, #64748b)', lineHeight: 1.45 }}>
                  {isEn ? meta.hintEn : meta.hintZh}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </DraggableModal>
  );
};

interface LightCitySculptBarProps {
  tool: TerrainTool;
  onChangeTool: (tool: TerrainTool) => void;
  riverWidth: number;
  onChangeRiverWidth: (w: number) => void;
  waterSubKind: 'water' | 'island';
  onChangeWaterSubKind: (k: 'water' | 'island') => void;
  zoneSubKind: Exclude<LightCityZoneKind, 'island'>;
  onChangeZoneSubKind: (k: Exclude<LightCityZoneKind, 'island'>) => void;
  roadSubKind: LightCityRoadKind;
  onChangeRoadSubKind: (k: LightCityRoadKind) => void;
  labelSubKind: LightCityLabelKind;
  onChangeLabelSubKind: (k: LightCityLabelKind) => void;
  draftPointCount: number;
  onFinishDraft: (closeLoop?: boolean) => void;
  onCancelDraft: () => void;
  selectedFeature: LightCityFeature | null;
  onUpdateSelectedFeature: (patch: Partial<LightCityFeature>) => void;
  onDeleteSelectedFeature: () => void;
  onRerollCity: () => void;
  onOpenTemplatePicker: () => void;
  onExitSculpt: () => void;
  language?: 'zh-CN' | 'en-US';
}

export const LightCitySculptBar: React.FC<LightCitySculptBarProps> = ({
  tool,
  onChangeTool,
  riverWidth,
  onChangeRiverWidth,
  waterSubKind,
  onChangeWaterSubKind,
  zoneSubKind,
  onChangeZoneSubKind,
  roadSubKind,
  onChangeRoadSubKind,
  labelSubKind,
  onChangeLabelSubKind,
  draftPointCount,
  onFinishDraft,
  onCancelDraft,
  selectedFeature,
  onUpdateSelectedFeature,
  onDeleteSelectedFeature,
  onRerollCity,
  onOpenTemplatePicker,
  onExitSculpt,
  language = 'zh-CN'
}) => {
  const isEn = language === 'en-US';
  const minPoints = tool === 'river' || tool === 'road' ? 2 : 3;

  return (
    <div
      className="metro-draw-subbar metro-lightcity-sculpt-bar"
      role="toolbar"
      aria-label={isEn ? 'Terrain sculpt tools' : '轻城市底图造景工具栏'}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <ElasticCapsuleTabs<TerrainTool>
        size="sm"
        ariaLabel={isEn ? 'Terrain brushes' : '地形画笔切换'}
        value={tool}
        onChange={onChangeTool}
        options={[
          { value: 'select', label: isEn ? 'Shape' : '塑形' },
          { value: 'river', label: isEn ? 'River' : '河流' },
          { value: 'waterArea', label: isEn ? 'Water' : '湖海/洲' },
          { value: 'zone', label: isEn ? 'Zone' : '片区' },
          { value: 'road', label: isEn ? 'Road' : '干道' },
          { value: 'label', label: isEn ? 'Label' : '地名' }
        ]}
      />

      {/* 各画笔上下文子控制（落点绘制中自动切换为紧凑收笔栏，保证整条工具栏永远单行不折行） */}
      {tool === 'river' && (
        <>
          <span className="metro-draw-subbar__sep" />
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <span style={{ fontSize: 12, opacity: 0.82 }}>{riverWidth}px</span>
            <div style={{ width: 64 }}>
              <Slider min={14} max={160} step={2} value={riverWidth} onChange={onChangeRiverWidth} tooltip={{ open: false }} />
            </div>
          </div>
        </>
      )}

      {draftPointCount === 0 && tool === 'waterArea' && (
        <>
          <span className="metro-draw-subbar__sep" />
          <ElasticCapsuleTabs<'water' | 'island'>
            size="sm"
            ariaLabel="水域或洲岛"
            value={waterSubKind}
            onChange={onChangeWaterSubKind}
            options={[
              { value: 'water', label: isEn ? 'Water' : '湖海' },
              { value: 'island', label: isEn ? 'Island' : '洲岛' }
            ]}
          />
        </>
      )}

      {draftPointCount === 0 && tool === 'zone' && (
        <>
          <span className="metro-draw-subbar__sep" />
          <ElasticCapsuleTabs<'urban' | 'park'>
            size="sm"
            ariaLabel="片区类型"
            value={zoneSubKind}
            onChange={onChangeZoneSubKind}
            options={[
              { value: 'urban', label: isEn ? 'Urban' : '城区' },
              { value: 'park', label: isEn ? 'Park' : '绿地' }
            ]}
          />
        </>
      )}

      {draftPointCount === 0 && tool === 'road' && (
        <>
          <span className="metro-draw-subbar__sep" />
          <ElasticCapsuleTabs<LightCityRoadKind>
            size="sm"
            ariaLabel="干道等级"
            value={roadSubKind}
            onChange={onChangeRoadSubKind}
            options={[
              { value: 'express', label: isEn ? 'Express' : '快速路' },
              { value: 'arterial', label: isEn ? 'Road' : '主干道' },
              { value: 'street', label: isEn ? 'Street' : '街巷' }
            ]}
          />
        </>
      )}

      {draftPointCount === 0 && tool === 'label' && (
        <>
          <span className="metro-draw-subbar__sep" />
          <ElasticCapsuleTabs<LightCityLabelKind>
            size="sm"
            ariaLabel="地名等级"
            value={labelSubKind}
            onChange={onChangeLabelSubKind}
            options={[
              { value: 'district', label: isEn ? 'District' : '大区' },
              { value: 'subdistrict', label: isEn ? 'Area' : '片区' },
              { value: 'water', label: isEn ? 'Water' : '水体' }
            ]}
          />
        </>
      )}

      {/* 正在落点绘制中的收笔控制 */}
      {draftPointCount > 0 && (
        <>
          <span className="metro-draw-subbar__sep" />
          {draftPointCount >= minPoints && (
            <button
              type="button"
              className="metro-draw-subbar__pill is-active"
              onClick={() => onFinishDraft(false)}
              title="右键或回车亦可直接完成"
            >
              <CheckOutlined /> {isEn ? 'Finish' : '完成'} ({draftPointCount})
            </button>
          )}
          {tool === 'road' && draftPointCount >= 3 && (
            <button
              type="button"
              className="metro-draw-subbar__pill"
              onClick={() => onFinishDraft(true)}
            >
              {isEn ? 'Ring' : '成环'}
            </button>
          )}
          <button
            type="button"
            className="metro-draw-subbar__pill"
            onClick={onCancelDraft}
          >
            {isEn ? 'Cancel' : '取消'}
          </button>
        </>
      )}

      {/* 选中既有地形要素时的属性与删除控制 */}
      {tool === 'select' && selectedFeature && (
        <>
          <span className="metro-draw-subbar__sep" />
          {selectedFeature.type === 'river' && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
              <span style={{ fontSize: 12 }}>{selectedFeature.width}px</span>
              <div style={{ width: 62 }}>
                <Slider
                  min={14}
                  max={160}
                  step={2}
                  value={selectedFeature.width}
                  onChange={(v) => onUpdateSelectedFeature({ width: v } as any)}
                  tooltip={{ open: false }}
                />
              </div>
            </div>
          )}
          {selectedFeature.type === 'zone' && (
            <ElasticCapsuleTabs<LightCityZoneKind>
              size="sm"
              ariaLabel="切换片区属性"
              value={selectedFeature.kind}
              onChange={(k) => onUpdateSelectedFeature({ kind: k } as any)}
              options={[
                { value: 'urban', label: isEn ? 'Urban' : '城区' },
                { value: 'park', label: isEn ? 'Park' : '绿地' },
                { value: 'island', label: isEn ? 'Island' : '洲岛' }
              ]}
            />
          )}
          {selectedFeature.type === 'road' && (
            <>
              <ElasticCapsuleTabs<LightCityRoadKind>
                size="sm"
                ariaLabel="切换干道等级"
                value={selectedFeature.kind}
                onChange={(k) => onUpdateSelectedFeature({ kind: k } as any)}
                options={[
                  { value: 'express', label: isEn ? 'Express' : '快速路' },
                  { value: 'arterial', label: isEn ? 'Road' : '主干道' },
                  { value: 'street', label: isEn ? 'Street' : '街巷' }
                ]}
              />
              <button
                type="button"
                className="metro-draw-subbar__pill"
                onClick={() =>
                  onUpdateSelectedFeature({
                    closed: selectedFeature.points.length >= 3 ? !selectedFeature.closed : false
                  } as any)
                }
              >
                {selectedFeature.closed ? (isEn ? 'Open' : '解环') : isEn ? 'Ring' : '成环'}
              </button>
            </>
          )}
          {selectedFeature.type === 'label' && (
            <Input
              size="small"
              style={{ width: 104, borderRadius: 8 }}
              value={selectedFeature.text}
              maxLength={24}
              onChange={(e) => onUpdateSelectedFeature({ text: e.target.value } as any)}
            />
          )}
          <button
            type="button"
            className="metro-draw-subbar__pill"
            style={{ color: '#ef4444' }}
            onClick={onDeleteSelectedFeature}
            title={isEn ? 'Delete (Del)' : '删除选中要素 (Delete)'}
          >
            <DeleteOutlined />
          </button>
        </>
      )}

      <span className="metro-draw-subbar__sep" />

      <button type="button" className="metro-draw-subbar__pill" onClick={onRerollCity} title="随机刷新当前模板城市形态">
        <ReloadOutlined /> {isEn ? 'Shuffle' : '换城'}
      </button>
      <button type="button" className="metro-draw-subbar__pill" onClick={onOpenTemplatePicker}>
        {isEn ? 'Presets' : '模板'}
      </button>
      <button
        type="button"
        className="metro-draw-subbar__pill metro-draw-subbar__pill--lift"
        onClick={onExitSculpt}
      >
        <CheckOutlined /> {isEn ? 'Done' : '完成造景'}
      </button>
    </div>
  );
};
