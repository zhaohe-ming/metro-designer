import React from 'react';
import { Dropdown } from 'antd';
import { DownOutlined, FullscreenOutlined, HomeOutlined, MinusOutlined, PlusOutlined } from '@ant-design/icons';

interface MobileViewControlsProps {
  language: 'zh-CN' | 'en-US';
  zoomLabel: string;
  isMapMode: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onZoomPercent: (percent: number) => void;
  onFitView: () => void;
  onResetView: () => void;
}

export default function MobileViewControls({
  language,
  zoomLabel,
  isMapMode,
  onZoomOut,
  onZoomIn,
  onZoomPercent,
  onFitView,
  onResetView
}: MobileViewControlsProps) {
  const english = language === 'en-US';
  const text = english
    ? {
        out: 'Zoom out',
        in: 'Zoom in',
        zoom: 'Zoom percentage',
        mapZoom: 'Map zoom level',
        view: 'View options',
        fit: 'Fit view',
        reset: 'Reset view'
      }
    : {
        out: '缩小',
        in: '放大',
        zoom: '缩放比例',
        mapZoom: '地图缩放级别',
        view: '视图选项',
        fit: '适应视图',
        reset: '重置视图'
      };

  return (
    <div className="metro-mobile-view-controls">
      <div className="metro-mobile-view-controls__zoom" role="group" aria-label={english ? 'Zoom' : '缩放'}>
        <button type="button" className="metro-mobile-view-controls__button" aria-label={text.out} onClick={onZoomOut}>
          <MinusOutlined />
        </button>
        {isMapMode ? (
          <span className="metro-mobile-view-controls__value" aria-label={`${text.mapZoom} ${zoomLabel}`}>
            {zoomLabel}
          </span>
        ) : (
          <Dropdown
            placement="top"
            trigger={['click']}
            menu={{
              items: [50, 75, 100, 125, 150, 200].map((percent) => ({
                key: String(percent),
                label: `${percent}%`,
                onClick: () => onZoomPercent(percent)
              }))
            }}
          >
            <button type="button" className="metro-mobile-view-controls__value" aria-label={text.zoom}>
              {zoomLabel}
              <DownOutlined className="metro-mobile-view-controls__caret" />
            </button>
          </Dropdown>
        )}
        <button type="button" className="metro-mobile-view-controls__button" aria-label={text.in} onClick={onZoomIn}>
          <PlusOutlined />
        </button>
      </div>
      <div className="metro-mobile-view-controls__view">
        <Dropdown
          placement="topRight"
          trigger={['click']}
          menu={{
            items: [
              { key: 'fit', label: text.fit, icon: <FullscreenOutlined />, onClick: onFitView },
              { key: 'reset', label: text.reset, icon: <HomeOutlined />, onClick: onResetView }
            ]
          }}
        >
          <button
            type="button"
            className="metro-mobile-view-controls__button metro-mobile-view-controls__view-button"
            aria-label={text.view}
          >
            <FullscreenOutlined />
            <DownOutlined className="metro-mobile-view-controls__caret" />
          </button>
        </Dropdown>
      </div>
    </div>
  );
}
