import React, { useState } from 'react';
import { Button, ColorPicker, Input, message, Select } from 'antd';
import { DownloadOutlined, PictureOutlined, PlusOutlined } from '@ant-design/icons';
import { LINE_COLORS, Line } from '../types';
import DraggableModal from './DraggableModal';

interface ToolbarProps {
  lines: Line[];
  currentLineId: string | null;
  onAddLine: (name: string, color: string) => boolean;
  onSelectLine: (id: string) => void;
  onExportImage?: () => void;
  onOpenVideoModal?: () => void;
}

const Toolbar: React.FC<ToolbarProps> = ({
  lines,
  currentLineId,
  onAddLine,
  onSelectLine,
  onExportImage,
  onOpenVideoModal
}) => {
  const [addingLine, setAddingLine] = useState(false);
  const [newLineName, setNewLineName] = useState('');
  const [selectedColor, setSelectedColor] = useState(LINE_COLORS[0]);
  const [showColorPicker, setShowColorPicker] = useState(false);

  const resetForm = () => {
    setAddingLine(false);
    setNewLineName('');
    setSelectedColor(LINE_COLORS[0]);
    setShowColorPicker(false);
  };

  const handleAddLine = () => {
    const trimmed = newLineName.trim();
    if (!trimmed) {
      message.warning('请输入线路名称');
      return;
    }

    const success = onAddLine(trimmed, selectedColor);
    if (success) {
      resetForm();
    }
  };

  return (
    <>
      <div className="metro-toolbar">
        <div className="metro-toolbar__left">
          <Button
            className="metro-toolbar__primary"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setAddingLine(true)}
          >
            新建线路
          </Button>

          <Select
            className="metro-toolbar__select"
            value={currentLineId || undefined}
            placeholder="切换当前线路"
            onChange={onSelectLine}
            options={lines.map((line) => ({
              label: (
                <span className="metro-select-option">
                  <span className="metro-select-option__dot" style={{ backgroundColor: line.color }} />
                  <span>{line.name}</span>
                </span>
              ),
              value: line.id
            }))}
          />
        </div>

        <div className="metro-toolbar__right">
          {onExportImage ? (
            <Button className="metro-toolbar__secondary" onClick={onExportImage} icon={<PictureOutlined />}>
              导出图片
            </Button>
          ) : null}
          {onOpenVideoModal ? (
            <Button className="metro-toolbar__secondary" onClick={onOpenVideoModal} icon={<DownloadOutlined />}>
              导出演示视频
            </Button>
          ) : null}
        </div>
      </div>

      <DraggableModal
        title="创建新线路"
        open={addingLine}
        onOk={handleAddLine}
        onCancel={resetForm}
        okText="创建线路"
        cancelText="取消"
      >
        <div className="metro-add-line-form__field">
          <div className="metro-form-label">线路名称</div>
          <Input
            placeholder="例如 1 号线 / 环线 / 机场快线"
            value={newLineName}
            onChange={(e) => setNewLineName(e.target.value)}
            maxLength={12}
          />
        </div>

        <div className="metro-add-line-form__field">
          <div className="metro-form-label">线路颜色</div>
          <div className="metro-color-grid">
            {LINE_COLORS.map((color) => (
              <div
                key={color}
                className={`metro-color-swatch ${selectedColor === color ? 'is-active' : ''}`}
                style={{ backgroundColor: color }}
                onClick={() => setSelectedColor(color)}
              />
            ))}
          </div>

          <div style={{ marginTop: 16 }}>
            <Button type="dashed" block onClick={() => setShowColorPicker((prev) => !prev)}>
              使用更多颜色
            </Button>
          </div>

          {showColorPicker ? (
            <div style={{ marginTop: 16 }}>
              <ColorPicker
                value={selectedColor}
                onChange={(color) => setSelectedColor(color.toHexString())}
                showText
              />
            </div>
          ) : null}
        </div>
      </DraggableModal>
    </>
  );
};

export default Toolbar;
