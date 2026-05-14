import React from 'react';
import { Button, Dropdown, Tooltip } from 'antd';
import {
  DownloadOutlined,
  DownOutlined,
  PictureOutlined,
  RedoOutlined,
  UndoOutlined,
  VideoCameraOutlined
} from '@ant-design/icons';

// 顶部 toolbar 重新定位为「跨方案的画布动作」：撤销/重做 + 导出。
// 「新建线路 / 切换线路」属于线路管理，已经收回左侧 Sidebar；导出图片 / 视频两个按钮合并成一个 dropdown。
interface ToolbarProps {
  language?: 'zh-CN' | 'en-US';
  onExportImage?: () => void;
  onOpenVideoModal?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
}

const Toolbar: React.FC<ToolbarProps> = ({
  language = 'zh-CN',
  onExportImage,
  onOpenVideoModal,
  onUndo,
  onRedo,
  canUndo,
  canRedo
}) => {
  const text = language === 'en-US'
    ? {
        exportLabel: 'Export',
        exportImage: 'Image',
        exportVideo: 'Demo video'
      }
    : {
        exportLabel: '导出',
        exportImage: '导出图片',
        exportVideo: '导出演示视频'
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
              onClick={onRedo}
              disabled={!canRedo}
              icon={<RedoOutlined />}
            />
          </Tooltip>
        ) : null}
        {exportItems.length ? (
          <Dropdown menu={{ items: exportItems }} placement="bottomRight" trigger={['click']}>
            <Button className="metro-toolbar__secondary" icon={<DownloadOutlined />}>
              {text.exportLabel} <DownOutlined style={{ fontSize: 10 }} />
            </Button>
          </Dropdown>
        ) : null}
      </div>
    </div>
  );
};

export default Toolbar;
