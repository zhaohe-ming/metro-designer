import React, { useEffect, useRef, useState } from 'react';
import { Button, ColorPicker, Dropdown, Modal, Space, Typography, message } from 'antd';
import Input from 'antd/es/input';
import { DeleteOutlined, DragOutlined, MoreOutlined, PlusOutlined, SwapOutlined } from '@ant-design/icons';
import { LINE_COLORS, Line, Station } from '../types';
import DraggableModal from './DraggableModal';

const { Text } = Typography;

interface SidebarProps {
  language?: 'zh-CN' | 'en-US';
  lines: Line[];
  stations: Station[];
  currentLineId: string | null;
  onSelectLine: (id: string) => void;
  onDeselectLine: () => void;
  onAddLine: (name: string, color: string) => boolean;
  onDeleteLine: (lineId: string) => void;
  onChangeLineColor: (lineId: string, newColor: string) => boolean;
  onChangeLineName?: (lineId: string, newName: string) => void;
  onRemoveStationFromLine: (lineId: string, stationId: string) => void;
  onReorderStations: (lineId: string, stationIds: string[]) => void;
  onReorderLines: (newOrder: string[]) => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  language = 'zh-CN',
  lines,
  stations,
  currentLineId,
  onSelectLine,
  onDeselectLine,
  onAddLine,
  onDeleteLine,
  onChangeLineColor,
  onChangeLineName,
  onReorderLines
}) => {
  const text = language === 'en-US'
    ? {
        title: 'Line workbench',
        subtitle: 'Manage line order, colors, and station overview. Use the canvas for spatial layout.',
        lineList: 'Lines',
        deselect: 'Deselect',
        reorder: 'Reorder',
        finishReorder: 'Done',
        reorderHint: 'Drag line cards to reorder.',
        emptyLines: 'No lines yet. Click the "+ New" button above to start.',
        emptyLinesTitle: 'No lines yet',
        emptyLinesText: 'Start your map by drawing the first metro line.',
        emptyLinesCta: 'Create first line',
        emptyStationsTitle: 'No stations yet',
        emptyStationsText: 'Click any blank spot on the canvas to add a station.',
        addLine: 'New',
        stationUnit: 'stations',
        sectionUnit: 'sections',
        active: 'Editing',
        expand: 'Expand',
        collapse: 'Collapse',
        noStations: 'No stations',
        allStations: 'All stations',
        emptyStations: 'Click blank canvas area to add stations.',
        changeName: 'Rename',
        changeColor: 'Change color',
        deleteLine: 'Delete line',
        confirmDelete: 'Confirm delete',
        confirmDeleteContent: (name: string) => `Delete line "${name}"? This cannot be undone.`,
        delete: 'Delete',
        cancel: 'Cancel',
        confirm: 'Confirm',
        nameModalTitle: 'Rename line',
        colorModalTitle: 'Change line color',
        namePlaceholder: 'Enter a new line name',
        colorLabel: 'Line color',
        moreColors: 'More colors',
        createLineTitle: 'Create new line',
        createLineOk: 'Create',
        lineNameField: 'Line name',
        lineNamePlaceholder: 'e.g. Line 1 / Loop / Airport Express',
        lineColorField: 'Line color',
        lineNameRequired: 'Please enter a line name'
      }
    : {
        title: '线路设计台',
        subtitle: '管理当前方案中的线路顺序、颜色与站点概览。左侧面板负责组织结构，主画布负责空间布局。',
        lineList: '线路列表',
        deselect: '取消选中',
        reorder: '调整顺序',
        finishReorder: '完成排序',
        reorderHint: '拖拽线路卡片即可重新排序',
        emptyLines: '还没有线路。点击上方"+ 新建"按钮创建第一条线路。',
        emptyLinesTitle: '还没有线路',
        emptyLinesText: '从绘制第一条线路开始你的方案。',
        emptyLinesCta: '创建第一条线路',
        emptyStationsTitle: '暂无站点',
        emptyStationsText: '在画布空白处点击即可创建站点。',
        addLine: '新建',
        stationUnit: '个站点',
        sectionUnit: '个区间',
        active: '当前编辑',
        expand: '展开',
        collapse: '收起',
        noStations: '暂无站点',
        allStations: '全部站点',
        emptyStations: '在主画布中点击空白区域即可新增站点。',
        changeName: '修改名称',
        changeColor: '修改颜色',
        deleteLine: '删除线路',
        confirmDelete: '确认删除',
        confirmDeleteContent: (name: string) => `确定要删除线路“${name}”吗？删除后无法恢复。`,
        delete: '删除',
        cancel: '取消',
        confirm: '确认',
        nameModalTitle: '修改线路名称',
        colorModalTitle: '修改线路颜色',
        namePlaceholder: '请输入新的线路名称',
        colorLabel: '选择线路颜色',
        moreColors: '使用更多颜色',
        createLineTitle: '创建新线路',
        createLineOk: '创建线路',
        lineNameField: '线路名称',
        lineNamePlaceholder: '例如 1 号线 / 环线 / 机场快线',
        lineColorField: '线路颜色',
        lineNameRequired: '请输入线路名称'
      };
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
  // "+ 新建" 模态从原顶部 Toolbar 搬过来：管理在"线路列表"自身才是正确位置
  const [addLineModal, setAddLineModal] = useState({
    visible: false,
    name: '',
    color: LINE_COLORS[0],
    showPicker: false
  });

  // 线路 list / 站点 list 之间的可拖拽分界比例。1.0 = 全归线路，0.0 = 全归站点。
  // 默认 0.5。clamp 到 [0.15, 0.85]，避免某一边塌成 0 高度。持久化到 localStorage。
  const SIDEBAR_SPLIT_KEY = 'metro_sidebar_split';
  const [linesFlex, setLinesFlex] = useState<number>(() => {
    try {
      const raw = window.localStorage?.getItem(SIDEBAR_SPLIT_KEY);
      const v = raw == null ? NaN : Number(raw);
      return Number.isFinite(v) && v >= 0.15 && v <= 0.85 ? v : 0.5;
    } catch {
      return 0.5;
    }
  });
  const linesFlexRef = useRef(linesFlex);
  linesFlexRef.current = linesFlex;
  const linesSectionRef = useRef<HTMLDivElement>(null);
  const stationsSectionRef = useRef<HTMLDivElement>(null);
  // 拖拽时记录起点：起始指针 Y、起始 flex 值、可分配总高度（两个 section 合计的实际像素高度）
  const splitterDragRef = useRef<{ startY: number; startFlex: number; available: number } | null>(null);
  const [isSplitterDragging, setIsSplitterDragging] = useState(false);

  useEffect(() => {
    // 持久化最新比例。setLinesFlex 节奏很高（拖拽时），所以这里 setState → effect 是合理 sink。
    try { window.localStorage?.setItem(SIDEBAR_SPLIT_KEY, String(linesFlex)); } catch { /* ignore */ }
  }, [linesFlex]);

  const handleSplitterPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const lines = linesSectionRef.current;
    const stations = stationsSectionRef.current;
    if (!lines || !stations) return;
    const available = lines.getBoundingClientRect().height + stations.getBoundingClientRect().height;
    if (available <= 0) return;
    splitterDragRef.current = { startY: e.clientY, startFlex: linesFlexRef.current, available };
    setIsSplitterDragging(true);
    // 全局光标 / 防止文本选中
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handleSplitterPointerMove);
    window.addEventListener('pointerup', handleSplitterPointerUp);
    window.addEventListener('pointercancel', handleSplitterPointerUp);
  };

  const handleSplitterPointerMove = (e: PointerEvent) => {
    if (!splitterDragRef.current) return;
    const { startY, startFlex, available } = splitterDragRef.current;
    const dy = e.clientY - startY;
    const next = Math.max(0.15, Math.min(0.85, startFlex + dy / available));
    setLinesFlex(next);
  };

  const handleSplitterPointerUp = () => {
    splitterDragRef.current = null;
    setIsSplitterDragging(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('pointermove', handleSplitterPointerMove);
    window.removeEventListener('pointerup', handleSplitterPointerUp);
    window.removeEventListener('pointercancel', handleSplitterPointerUp);
  };

  // 双击复位到 50/50
  const handleSplitterDoubleClick = () => {
    setLinesFlex(0.5);
  };

  const openAddLineModal = () => {
    setAddLineModal({
      visible: true,
      name: '',
      color: LINE_COLORS[0],
      showPicker: false
    });
  };

  const closeAddLineModal = () => {
    setAddLineModal({ visible: false, name: '', color: LINE_COLORS[0], showPicker: false });
  };

  const handleConfirmAddLine = () => {
    const trimmed = addLineModal.name.trim();
    if (!trimmed) {
      message.warning(text.lineNameRequired);
      return;
    }
    const ok = onAddLine(trimmed, addLineModal.color);
    if (ok) closeAddLineModal();
  };

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
      label: text.changeName,
      onClick: () => openNameModal(line)
    },
    {
      key: 'change-color',
      label: text.changeColor,
      onClick: () => openColorModal(line)
    },
    {
      key: 'delete',
      danger: true,
      icon: <DeleteOutlined />,
      label: text.deleteLine,
      onClick: () => {
        Modal.confirm({
          title: text.confirmDelete,
          content: text.confirmDeleteContent(line.name),
          okText: text.delete,
          cancelText: text.cancel,
          okType: 'danger',
          onOk: () => onDeleteLine(line.id)
        });
      }
    }
  ];

  return (
    <div className="metro-sidebar">
      <div className="metro-sidebar__title">{text.title}</div>
      <div className="metro-sidebar__subtitle">
        {text.subtitle}
      </div>

      <div
        className="metro-sidebar__section"
        ref={linesSectionRef}
        style={{ flexGrow: linesFlex }}
      >
        <div className="metro-sidebar__section-head">
          <div className="metro-sidebar__section-title">{text.lineList}</div>
          <Button
            className="metro-sidebar__add-btn"
            type="primary"
            size="small"
            icon={<PlusOutlined />}
            onClick={openAddLineModal}
          >
            {text.addLine}
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
                {text.reorder}
              </Button>
            ) : (
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <Button
                  className="metro-sidebar__ghost-btn"
                  size="small"
                  icon={<SwapOutlined />}
                  onClick={handleCancelLineReorder}
                >
                  {text.finishReorder}
                </Button>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {text.reorderHint}
                </Text>
              </Space>
            )}
          </div>
        ) : null}

        <div className="metro-line-list" onClick={handleLinesAreaClick}>
          {lines.length === 0 ? (
            <div className="metro-empty-card metro-empty-card--lines">
              {/* 抽象轨道图：3 个站点圆点 + 一根弧线 */}
              <svg
                className="metro-empty-card__art"
                width="84"
                height="60"
                viewBox="0 0 84 60"
                aria-hidden="true"
              >
                <path
                  d="M10 42 Q 28 12 42 30 T 74 18"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  fill="none"
                  opacity="0.55"
                />
                <circle cx="10" cy="42" r="4" fill="currentColor" />
                <circle cx="42" cy="30" r="5" fill="currentColor" />
                <circle cx="74" cy="18" r="4" fill="currentColor" />
                <circle cx="42" cy="30" r="2" fill="#ffffff" />
              </svg>
              <div className="metro-empty-card__title">{text.emptyLinesTitle}</div>
              <div className="metro-empty-card__text">{text.emptyLinesText}</div>
              <Button
                type="primary"
                size="small"
                icon={<PlusOutlined />}
                onClick={openAddLineModal}
                className="metro-empty-card__cta"
              >
                {text.emptyLinesCta}
              </Button>
            </div>
          ) : (
            lines.map((line) => {
              const active = currentLineId === line.id;
              const lineStations = getLineStations(line);

              return (
                <article
                  key={line.id}
                  // --accent-color 一份传给 article，accent bar + active 状态的 border/glow 都用同一个变量
                  style={{ ['--accent-color' as any]: line.color }}
                  className={`metro-line-card ${active ? 'is-active' : ''} ${isReorderingLines ? 'is-reordering' : ''}`}
                  onClick={() => {
                    if (isReorderingLines) return;
                    // 已选中再次单击 = 取消选中（取代之前独立的"取消选中"按钮）
                    if (active) onDeselectLine();
                    else onSelectLine(line.id);
                  }}
                  onDragOver={isReorderingLines ? (event) => handleLineDragOver(event, line.id) : undefined}
                  onDrop={isReorderingLines ? (event) => handleLineDrop(event, line.id) : undefined}
                >
                  <div className="metro-line-card__accent" />

                  <div className="metro-line-card__body">
                    <div className="metro-line-card__top">
                      <div className="metro-line-card__meta">
                        {isReorderingLines ? (
                          <DragOutlined style={{ color: 'var(--color-text-muted, #a39b8c)', marginTop: 4, fontSize: 16 }} />
                        ) : (
                          <span className="metro-line-card__swatch" style={{ backgroundColor: line.color }} />
                        )}

                        <div style={{ minWidth: 0 }}>
                          <div className="metro-line-card__name">{line.name}</div>
                          <div className="metro-line-card__sub">
                            <span>{line.stationIds.length} {text.stationUnit}</span>
                            <span>{line.sectionIds.length} {text.sectionUnit}</span>
                            {active ? <span className="metro-line-card__active-pill">{text.active}</span> : null}
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
                          {expandedLines[line.id] ? text.collapse : text.expand}
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
                          <span className="metro-line-card__station-tag">{text.noStations}</span>
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
                          // 跟 .metro-line-card 的 --radius-md (8px) 对齐
                          borderRadius: 8,
                          background: dragOverLineId === line.id ? 'rgba(74, 107, 140, 0.12)' : 'transparent'
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

      {/* 可拖拽分界条：在线路 list 和站点 list 之间。双击复位 50/50。 */}
      <div
        className={`metro-sidebar__splitter ${isSplitterDragging ? 'is-dragging' : ''}`}
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整线路列表与站点列表的高度"
        onPointerDown={handleSplitterPointerDown}
        onDoubleClick={handleSplitterDoubleClick}
      >
        <div className="metro-sidebar__splitter-grip" aria-hidden="true" />
      </div>

      <div
        className="metro-sidebar__section"
        ref={stationsSectionRef}
        style={{ flexGrow: 1 - linesFlex }}
      >
        <div className="metro-sidebar__section-head">
          <div className="metro-sidebar__section-title">{text.allStations}</div>
          <Text type="secondary">{stations.length}</Text>
        </div>

        <div className="metro-station-list">
          {stations.length === 0 ? (
            <div className="metro-empty-card metro-empty-card--stations">
              {/* 单站点的小图：一个被光圈包围的圆点 */}
              <svg
                className="metro-empty-card__art"
                width="60"
                height="60"
                viewBox="0 0 60 60"
                aria-hidden="true"
              >
                <circle cx="30" cy="30" r="20" fill="currentColor" opacity="0.10" />
                <circle cx="30" cy="30" r="12" fill="currentColor" opacity="0.18" />
                <circle cx="30" cy="30" r="6" fill="currentColor" />
                <circle cx="30" cy="30" r="2.5" fill="#ffffff" />
              </svg>
              <div className="metro-empty-card__title">{text.emptyStationsTitle}</div>
              <div className="metro-empty-card__text">{text.emptyStationsText}</div>
            </div>
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
        title={text.nameModalTitle}
        open={nameChangeModal.visible}
        onOk={handleConfirmNameChange}
        onCancel={closeNameModal}
        okText={text.confirm}
        cancelText={text.cancel}
      >
        <Input
          value={nameChangeModal.currentName}
          onChange={(event) =>
            setNameChangeModal((prev) => ({
              ...prev,
              currentName: event.target.value
            }))
          }
          placeholder={text.namePlaceholder}
          maxLength={20}
        />
      </DraggableModal>

      <DraggableModal
        title={text.colorModalTitle}
        open={colorChangeModal.visible}
        onOk={handleConfirmColorChange}
        onCancel={closeColorModal}
        okText={text.confirm}
        cancelText={text.cancel}
      >
        <div className="metro-form-label">{text.colorLabel}</div>
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
            {text.moreColors}
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

      {/* 「+ 新建」模态：原本在顶部 Toolbar，搬到这里跟它的归属（线路设计台）放一起 */}
      <DraggableModal
        title={text.createLineTitle}
        open={addLineModal.visible}
        onOk={handleConfirmAddLine}
        onCancel={closeAddLineModal}
        okText={text.createLineOk}
        cancelText={text.cancel}
      >
        <div className="metro-add-line-form__field">
          <div className="metro-form-label">{text.lineNameField}</div>
          <Input
            placeholder={text.lineNamePlaceholder}
            value={addLineModal.name}
            onChange={(e) => setAddLineModal((prev) => ({ ...prev, name: e.target.value }))}
            onPressEnter={handleConfirmAddLine}
            maxLength={12}
          />
        </div>
        <div className="metro-add-line-form__field">
          <div className="metro-form-label">{text.lineColorField}</div>
          <div className="metro-color-grid">
            {LINE_COLORS.map((color) => (
              <div
                key={color}
                className={`metro-color-swatch ${addLineModal.color === color ? 'is-active' : ''}`}
                style={{ backgroundColor: color }}
                onClick={() => setAddLineModal((prev) => ({ ...prev, color }))}
              />
            ))}
          </div>
          <div style={{ marginTop: 16 }}>
            <Button
              type="dashed"
              block
              onClick={() => setAddLineModal((prev) => ({ ...prev, showPicker: !prev.showPicker }))}
            >
              {text.moreColors}
            </Button>
          </div>
          {addLineModal.showPicker ? (
            <div style={{ marginTop: 16 }}>
              <ColorPicker
                value={addLineModal.color}
                onChange={(color) => setAddLineModal((prev) => ({ ...prev, color: color.toHexString() }))}
                showText
              />
            </div>
          ) : null}
        </div>
      </DraggableModal>
    </div>
  );
};

export default Sidebar;
