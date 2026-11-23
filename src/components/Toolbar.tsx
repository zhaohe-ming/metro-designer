import React from 'react';
import { Button, Dropdown, Tooltip } from 'antd';
import {
  AppstoreOutlined,
  DownloadOutlined,
  DownOutlined,
  PictureOutlined,
  RedoOutlined,
  UndoOutlined,
  VideoCameraOutlined
} from '@ant-design/icons';

// 顶部 toolbar 承载「跨方案画布动作 + 社区入口」：撤销/重做 + 导出 + 作品广场。
interface ToolbarProps {
  language?: 'zh-CN' | 'en-US';
  onExportImage?: () => void;
  onOpenVideoModal?: () => void;
  onOpenGallery?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  mobileViewControlsRef?: React.Ref<HTMLDivElement>;
}

const Toolbar: React.FC<ToolbarProps> = ({
  language = 'zh-CN',
  onExportImage,
  onOpenVideoModal,
  onOpenGallery,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  mobileViewControlsRef
}) => {
  const text = language === 'en-US'
    ? {
        exportLabel: 'Export',
        exportImage: 'Image',
        exportVideo: 'Demo video',
        galleryLabel: 'Gallery'
      }
    : {
        exportLabel: '导出',
        exportImage: '导出图片',
        exportVideo: '导出演示视频',
        galleryLabel: '作品广场'
      };
  const undoText = language === 'en-US' ? 'Undo (Ctrl+Z)' : '撤销 (Ctrl+Z)';
  const redoText = language === 'en-US' ? 'Redo (Ctrl+Shift+Z)' : '重做 (Ctrl+Shift+Z)';

  const exportItems = [
    onExportImage
      ? {
          key: 'image',
          icon: <PictureOutlined />,
          label: text.exportImage,
          onClick: onExportImage
        }
      : null,
    onOpenVideoModal
      ? {
          key: 'video',
          icon: <VideoCameraOutlined />,
          label: text.exportVideo,
          onClick: onOpenVideoModal
        }
      : null
  ].filter(Boolean) as Array<{ key: string; icon: React.ReactNode; label: string; onClick: () => void }>;

  return (
    <div className="metro-toolbar">
      <div className="metro-toolbar__right">
        {onUndo ? (
          <Tooltip title={undoText}>
            <Button
              className="metro-toolbar__secondary"
              aria-label={language === 'en-US' ? 'Undo' : '撤销'}
              onClick={onUndo}
              disabled={!canUndo}
              icon={<UndoOutlined />}
            />
          </Tooltip>
        ) : null}
        {onRedo ? (
          <Tooltip title={redoText}>
            <Button
              className="metro-toolbar__secondary"
              aria-label={language === 'en-US' ? 'Redo' : '重做'}
              onClick={onRedo}
              disabled={!canRedo}
              icon={<RedoOutlined />}
            />
          </Tooltip>
        ) : null}
        <div className="metro-toolbar__mobile-view-slot" ref={mobileViewControlsRef} />
        {exportItems.length ? (
          <Dropdown menu={{ items: exportItems }} placement="bottomRight" trigger={['click']}>
            <Button className="metro-toolbar__secondary metro-toolbar__export" icon={<DownloadOutlined />}>
              {text.exportLabel} <DownOutlined style={{ fontSize: 10 }} />
            </Button>
          </Dropdown>
        ) : null}
        {onOpenGallery ? (
          <>
            <span className="metro-toolbar__sep" aria-hidden="true" />
            <Button
              className="metro-toolbar__secondary metro-toolbar__gallery"
              icon={<AppstoreOutlined />}
              onClick={onOpenGallery}
            >
              {text.galleryLabel}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
};

export default Toolbar;
