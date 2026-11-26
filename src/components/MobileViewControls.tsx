import React from 'react';
import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import {
  DownOutlined,
  FullscreenOutlined,
  HomeOutlined,
  MinusOutlined,
  PlusOutlined
} from '@ant-design/icons';

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
        view: 'View & zoom',
        fit: 'Fit all lines',
        reset: 'Reset view (100%)'
      }
    : {
        out: '缩小视图',
        in: '放大视图',
        view: '视图与缩放',
        fit: '适应全图',
        reset: '重置视图 (100%)'
      };

  const presetItems: NonNullable<MenuProps['items']> = !isMapMode
    ? [
        { type: 'divider' },
        ...[50, 100, 150, 200].map((percent) => ({
          key: `p_${percent}`,
          label: `${percent}%`,
          onClick: () => onZoomPercent(percent)
        }))
      ]
    : [];

  const items: NonNullable<MenuProps['items']> = [
    { key: 'fit', label: text.fit, icon: <FullscreenOutlined />, onClick: onFitView },
    { key: 'reset', label: text.reset, icon: <HomeOutlined />, onClick: onResetView },
    { type: 'divider' },
    { key: 'in', label: text.in, icon: <PlusOutlined />, onClick: onZoomIn },
    { key: 'out', label: text.out, icon: <MinusOutlined />, onClick: onZoomOut },
    ...presetItems
  ];

  return (
    <div className="metro-mobile-view-controls">
      <Dropdown placement="top" trigger={['click']} menu={{ items }}>
        <button
          type="button"
          className="metro-mobile-view-controls__trigger"
          aria-label={`${text.view} ${zoomLabel}`}
        >
          <FullscreenOutlined className="metro-mobile-view-controls__icon" />
          <span className="metro-mobile-view-controls__label">{zoomLabel}</span>
          <DownOutlined className="metro-mobile-view-controls__caret" />
        </button>
      </Dropdown>
    </div>
  );
}
