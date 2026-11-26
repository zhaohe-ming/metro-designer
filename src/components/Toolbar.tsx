import React from 'react';
import { Button, Dropdown, Tooltip } from 'antd';
import {
  AppstoreOutlined,
  DownloadOutlined,
  DownOutlined,
  FileImageOutlined,
  PictureOutlined,
  QuestionCircleOutlined,
  RedoOutlined,
  UndoOutlined,
  VideoCameraOutlined
} from '@ant-design/icons';

// 顶部 toolbar 承载「跨方案画布动作 + 社区入口」：撤销/重做 + 导出 + 作品广场。
interface ToolbarProps {
  language?: 'zh-CN' | 'en-US';
  onExportImage?: () => void;
  onExportSvg?: () => void;
  onOpenVideoModal?: () => void;
  onOpenGallery?: () => void;
  onOpenGuide?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  mobileToolDockRef?: React.Ref<HTMLDivElement>;
  mobileViewControlsRef?: React.Ref<HTMLDivElement>;
}

const Toolbar: React.FC<ToolbarProps> = ({
  language = 'zh-CN',
  onExportImage,
  onExportSvg,
  onOpenVideoModal,
  onOpenGallery,
  onOpenGuide,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  mobileToolDockRef,
  mobileViewControlsRef
}) => {
  const text = language === 'en-US'
    ? {
        exportLabel: 'Export',
        exportImage: 'PNG Image',
        exportSvg: 'SVG Vector',
        exportVideo: 'Demo video',
        galleryLabel: 'Gallery'
      }
    : {
        exportLabel: '导出',
        exportImage: '导出图片 (PNG)',
        exportSvg: '导出矢量图 (SVG)',
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
    onExportSvg
      ? {
          key: 'svg',
          icon: <FileImageOutlined />,
          label: text.exportSvg,
          onClick: onExportSvg
        }
      : null,
    onOpenVideoModal
      ? {
          key: 'video',
          icon: <VideoCameraOutlined />,
          label: text.exportVideo,
          onClick: onOpenVideoModal
        }
      : null,
    onOpenGuide
      ? {
          key: 'guide',
          className: 'metro-user-menu__mobile-only',
          icon: <QuestionCircleOutlined />,
          label: language === 'en-US' ? 'Touch & Shortcut Guide' : '手势与操作指南',
          onClick: onOpenGuide
        }
      : null
  ].filter(Boolean) as Array<{ key: string; className?: string; icon: React.ReactNode; label: string; onClick: () => void }>;

  return (
    <div className="metro-toolbar">
      <div className="metro-toolbar__right">
        <div className="metro-toolbar__mobile-tools-slot" ref={mobileToolDockRef} />
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
