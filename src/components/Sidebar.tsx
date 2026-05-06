import React, { useState } from 'react';
import { Button, ColorPicker, Divider, Dropdown, Modal, Space, Typography } from 'antd';
import Input from 'antd/es/input';
import { DeleteOutlined, DragOutlined, MoreOutlined, SwapOutlined } from '@ant-design/icons';
import { LINE_COLORS, Line, Station } from '../types';
import DraggableModal from './DraggableModal';

const { Text } = Typography;

interface SidebarProps {
  lines: Line[];
  stations: Station[];
  currentLineId: string | null;
  onSelectLine: (id: string) => void;
  onDeselectLine: () => void;
  onDeleteLine: (lineId: string) => void;
  onChangeLineColor: (lineId: string, newColor: string) => boolean;
  onChangeLineName?: (lineId: string, newName: string) => void;
  onRemoveStationFromLine: (lineId: string, stationId: string) => void;
  onReorderStations: (lineId: string, stationIds: string[]) => void;
  onReorderLines: (newOrder: string[]) => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  lines,
  stations,
  currentLineId,
  onSelectLine,
  onDeselectLine,
  onDeleteLine,
  onChangeLineColor,
  onChangeLineName,
  onReorderLines
}) => {
  const [expandedLines, setExpandedLines] = useState<Record<string, boolean>>({});
  const [isReorderingLines, setIsReorderingLines] = useState(false);
  const [draggedLineId, setDraggedLineId] = useState<string | null>(null);
  const [dragOverLineId, setDragOverLineId] = useState<string | null>(null);
  const [nameChangeModal, setNameChangeModal] = useState({
    visible: false,
    lineId: null as string | null,
    currentName: ''
  });
  const [colorChangeModal, setColorChangeModal] = useState({
    visible: false,
    lineId: null as string | null,
    currentColor: '',
    showPicker: false
  });

  const toggleLineExpand = (lineId: string) => {
    setExpandedLines((prev) => ({
      ...prev,
      [lineId]: !prev[lineId]
    }));
  };

  const getLineStations = (line: Line) => {
    return line.stationIds
      .map((id) => stations.find((station) => station.id === id))
      .filter(Boolean) as Station[];
  };

  const openNameModal = (line: Line) => {
    setNameChangeModal({
      visible: true,
      lineId: line.id,
      currentName: line.name
    });
  };

  const openColorModal = (line: Line) => {
    setColorChangeModal({
      visible: true,
      lineId: line.id,
      currentColor: line.color,
      showPicker: false
    });
  };

  const closeNameModal = () => {
    setNameChangeModal({
      visible: false,
      lineId: null,
      currentName: ''
    });
  };

  const closeColorModal = () => {
    setColorChangeModal({
      visible: false,
      lineId: null,
      currentColor: '',
      showPicker: false
    });
  };

  const handleConfirmNameChange = () => {
    const trimmed = nameChangeModal.currentName.trim();
    if (!nameChangeModal.lineId || !trimmed || typeof onChangeLineName !== 'function') {
      return;
    }

    onChangeLineName(nameChangeModal.lineId, trimmed);
    closeNameModal();
  };

  const handleConfirmColorChange = () => {
    if (!colorChangeModal.lineId || !colorChangeModal.currentColor) {
      return;
    }

    const success = onChangeLineColor(colorChangeModal.lineId, colorChangeModal.currentColor);
    if (success) {
      closeColorModal();
    }
  };

  const handleStartLineReorder = () => {
    setExpandedLines({});
    setIsReorderingLines(true);
  };

  const handleCancelLineReorder = () => {
    setIsReorderingLines(false);
    setDraggedLineId(null);
    setDragOverLineId(null);
  };

  const handleLinesAreaClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && !isReorderingLines) {
      onDeselectLine();
    }
  };

  const handleLineDragStart = (event: React.DragEvent<HTMLElement>, lineId: string) => {
    setDraggedLineId(lineId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', lineId);
  };

  const handleLineDragOver = (event: React.DragEvent<HTMLElement>, lineId: string) => {
    event.preventDefault();
    if (draggedLineId && draggedLineId !== lineId) {
      setDragOverLineId(lineId);
    }
  };

  const handleLineDrop = (event: React.DragEvent<HTMLElement>, targetLineId: string) => {
    event.preventDefault();
    const draggedId = event.dataTransfer.getData('text/plain');

    if (draggedId && draggedId !== targetLineId) {
      const nextOrder = lines.map((line) => line.id);
      const draggedIndex = nextOrder.indexOf(draggedId);
      const targetIndex = nextOrder.indexOf(targetLineId);

      if (draggedIndex !== -1 && targetIndex !== -1) {
        nextOrder.splice(draggedIndex, 1);
        nextOrder.splice(targetIndex, 0, draggedId);
        onReorderLines(nextOrder);
      }
    }

    setDraggedLineId(null);
    setDragOverLineId(null);
  };

  const getContextMenuItems = (line: Line) => [
    {
      key: 'change-name',
      label: '修改名称',
      onClick: () => openNameModal(line)
    },
    {
      key: 'change-color',
      label: '修改颜色',
      onClick: () => openColorModal(line)
    },
    {
      key: 'delete',
      danger: true,
      icon: <DeleteOutlined />,
      label: '删除线路',
      onClick: () => {
        Modal.confirm({
          title: '确认删除',
          content: `确定要删除线路“${line.name}”吗？删除后无法恢复。`,
          okText: '删除',
          cancelText: '取消',
          okType: 'danger',
          onOk: () => onDeleteLine(line.id)
        });
      }
    }
  ];

  return (
    <div className="metro-sidebar">
      <div className="metro-sidebar__title">线路设计台</div>
      <div className="metro-sidebar__subtitle">
        管理当前方案中的线路顺序、颜色与站点概览。左侧面板负责组织结构，主画布负责空间布局。
      </div>

      <div className="metro-sidebar__section">
        <div className="metro-sidebar__section-head">
          <div className="metro-sidebar__section-title">线路列表</div>
          <Button className="metro-sidebar__ghost-btn" size="small" onClick={onDeselectLine} disabled={!currentLineId}>
            取消选中
          </Button>
        </div>

        {lines.length > 1 ? (
          <div style={{ marginBottom: 12 }}>
            {!isReorderingLines ? (
              <Button
                className="metro-sidebar__ghost-btn"
                size="small"
                icon={<SwapOutlined />}
                onClick={handleStartLineReorder}
              >
                调整顺序
              </Button>
            ) : (
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <Button
                  className="metro-sidebar__ghost-btn"
                  size="small"
                  icon={<SwapOutlined />}
                  onClick={handleCancelLineReorder}
                >
                  完成排序
                </Button>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  拖拽线路卡片即可重新排序
                </Text>
              </Space>
            )}
          </div>
        ) : null}

        <div className="metro-line-list" onClick={handleLinesAreaClick}>
          {lines.length === 0 ? (
            <div className="metro-empty-card">还没有线路。请先在顶部工具栏中创建第一条线路。</div>
          ) : (
            lines.map((line) => {
              const active = currentLineId === line.id;
              const lineStations = getLineStations(line);

              return (
                <article
                  key={line.id}
                  className={`metro-line-card ${active ? 'is-active' : ''} ${isReorderingLines ? 'is-reordering' : ''}`}
                  onClick={() => !isReorderingLines && onSelectLine(line.id)}
                  onDragOver={isReorderingLines ? (event) => handleLineDragOver(event, line.id) : undefined}
                  onDrop={isReorderingLines ? (event) => handleLineDrop(event, line.id) : undefined}
                >
                  <div className="metro-line-card__accent" style={{ backgroundColor: line.color }} />

                  <div className="metro-line-card__body">
                    <div className="metro-line-card__top">
                      <div className="metro-line-card__meta">
                        {isReorderingLines ? (
                          <DragOutlined style={{ color: '#6f7f98', marginTop: 4, fontSize: 16 }} />
                        ) : (
                          <span className="metro-line-card__swatch" style={{ backgroundColor: line.color }} />
                        )}

                        <div style={{ minWidth: 0 }}>
                          <div className="metro-line-card__name">{line.name}</div>
                          <div className="metro-line-card__sub">
                            <span>{line.stationIds.length} 个站点</span>
                            <span>{line.sectionIds.length} 个区间</span>
                            {active ? <span>当前编辑</span> : null}
                          </div>
                        </div>
                      </div>

                      <Space size={6}>
                        <Button
                          className="metro-line-card__action"
                          type="text"
                          size="small"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!isReorderingLines) {
                              toggleLineExpand(line.id);
                            }
                          }}
                        >
                          {expandedLines[line.id] ? '收起' : '展开'}
                        </Button>

                        <Dropdown menu={{ items: getContextMenuItems(line) }} trigger={['click']}>
                          <Button
                            className="metro-line-card__action"
                            type="text"
                            size="small"
                            icon={<MoreOutlined />}
                            onClick={(event) => event.stopPropagation()}
                          />
                        </Dropdown>
                      </Space>
                    </div>

                    {expandedLines[line.id] ? (
                      <div className="metro-line-card__stations">
                        {lineStations.length === 0 ? (
                          <span className="metro-line-card__station-tag">暂无站点</span>
                        ) : (
                          lineStations.map((station) => (
                            <span key={station.id} className="metro-line-card__station-tag">
                              {station.name}
                            </span>
                          ))
                        )}
                      </div>
                    ) : null}

                    {isReorderingLines ? (
                      <div
                        draggable
                        onDragStart={(event) => handleLineDragStart(event, line.id)}
                        onDragEnd={() => {
                          setDraggedLineId(null);
                          setDragOverLineId(null);
                        }}
                        style={{
                          position: 'absolute',
                          inset: 0,
                          borderRadius: 18,
                          background: dragOverLineId === line.id ? 'rgba(47, 109, 246, 0.08)' : 'transparent'
                        }}
                      />
                    ) : null}
                  </div>
                </article>
              );
            })
          )}
        </div>
      </div>

      <Divider />

      <div className="metro-sidebar__section">
        <div className="metro-sidebar__section-head">
          <div className="metro-sidebar__section-title">全部站点</div>
          <Text type="secondary">{stations.length}</Text>
        </div>

        <div className="metro-station-list">
          {stations.length === 0 ? (
            <div className="metro-empty-card">在主画布中点击空白区域即可新增站点。</div>
          ) : (
            stations.map((station) => (
              <div key={station.id} className="metro-station-item">
                <div>{station.name}</div>
                <div className="metro-station-item__coords">
                  {station.x.toFixed(0)}, {station.y.toFixed(0)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <DraggableModal
        title="修改线路名称"
        open={nameChangeModal.visible}
        onOk={handleConfirmNameChange}
        onCancel={closeNameModal}
        okText="确认"
        cancelText="取消"
      >
        <Input
          value={nameChangeModal.currentName}
          onChange={(event) =>
            setNameChangeModal((prev) => ({
              ...prev,
              currentName: event.target.value
            }))
          }
          placeholder="请输入新的线路名称"
          maxLength={20}
        />
      </DraggableModal>

      <DraggableModal
        title="修改线路颜色"
        open={colorChangeModal.visible}
        onOk={handleConfirmColorChange}
        onCancel={closeColorModal}
        okText="确认"
        cancelText="取消"
      >
        <div className="metro-form-label">选择线路颜色</div>
        <div className="metro-color-grid">
          {LINE_COLORS.map((color) => (
            <div
              key={color}
              className={`metro-color-swatch ${color === colorChangeModal.currentColor ? 'is-active' : ''}`}
              style={{ backgroundColor: color }}
              onClick={() => setColorChangeModal((prev) => ({ ...prev, currentColor: color }))}
            />
          ))}
        </div>

        <div style={{ marginTop: 16 }}>
          <Button
            type="dashed"
            block
            onClick={() => setColorChangeModal((prev) => ({ ...prev, showPicker: !prev.showPicker }))}
          >
            使用更多颜色
          </Button>
        </div>

        {colorChangeModal.showPicker ? (
          <div style={{ marginTop: 16 }}>
            <ColorPicker
              value={colorChangeModal.currentColor || '#1890ff'}
              onChange={(color) =>
                setColorChangeModal((prev) => ({
                  ...prev,
                  currentColor: color.toHexString()
                }))
              }
              showText
            />
          </div>
        ) : null}
      </DraggableModal>
    </div>
  );
};

export default Sidebar;
