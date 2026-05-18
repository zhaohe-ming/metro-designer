import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Modal, Select, Space, Typography, message } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Line, Station } from '../types';
import DraggableModal from './DraggableModal';

const { Text } = Typography;

export interface VideoSegmentInput {
  id: string;
  lineId: string;
  startStationId: string;
  endStationId: string;
  openDate: string;
}

// 完整的导出参数：除了区间表，还有片头标题等观感配置。
// 加新字段时只用扩展这里 + exportVideo.ts 的 ExportVideoOptions，
// VideoExportModal 自己消化默认值。
export interface VideoExportConfig {
  segments: VideoSegmentInput[];
  title: string;
  subtitle: string;
  titleDurationSec: number;
}

interface VideoExportModalProps {
  open: boolean;
  lines: Line[];
  stations: Station[];
  // 当前方案名 → 作为默认主标题；空时退回到通用文案
  defaultTitle?: string;
  onCancel: () => void;
  onConfirm: (config: VideoExportConfig) => void;
}

const createEmptySegment = (): VideoSegmentInput => ({
  id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  lineId: '',
  startStationId: '',
  endStationId: '',
  openDate: ''
});

const DEFAULT_TITLE_DURATION_SEC = 3;

const VideoExportModal: React.FC<VideoExportModalProps> = ({
  open,
  lines,
  stations,
  defaultTitle,
  onCancel,
  onConfirm
}) => {
  const [segments, setSegments] = useState<VideoSegmentInput[]>([createEmptySegment()]);
  // 片头配置；title 默认 = 当前方案名；模态被打开 / defaultTitle 变化时同步一次
  const [title, setTitle] = useState<string>(defaultTitle || '城市轨道线网历程');
  const [subtitle, setSubtitle] = useState<string>('');
  const [titleDurationSec, setTitleDurationSec] = useState<number>(DEFAULT_TITLE_DURATION_SEC);

  useEffect(() => {
    if (open) {
      setTitle((prev) => prev || defaultTitle || '城市轨道线网历程');
    }
  }, [open, defaultTitle]);

  const lineOptions = lines.map((line) => ({ label: line.name, value: line.id }));

  const getStationOptions = (lineId: string) => {
    const line = lines.find((item) => item.id === lineId);
    if (!line) return [];

    return line.stationIds
      .map((id) => stations.find((station) => station.id === id))
      .filter(Boolean)
      .map((station) => ({
        label: station!.name,
        value: station!.id
      }));
  };

  const sortedSegments = useMemo(() => {
    return [...segments].sort((a, b) => {
      if (a.openDate && b.openDate) return a.openDate.localeCompare(b.openDate);
      if (a.openDate) return -1;
      if (b.openDate) return 1;
      return segments.indexOf(a) - segments.indexOf(b);
    });
  }, [segments]);

  const handleAddRow = () => {
    setSegments((prev) => [...prev, createEmptySegment()]);
  };

  const handleDeleteRow = (id: string) => {
    if (segments.length === 1) {
      message.warning('至少保留一个区间');
      return;
    }
    setSegments((prev) => prev.filter((item) => item.id !== id));
  };

  const handleChange = (id: string, patch: Partial<VideoSegmentInput>) => {
    setSegments((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const handleConfirm = () => {
    const hasInvalid = segments.some(
      (segment) =>
        !segment.lineId ||
        !segment.startStationId ||
        !segment.endStationId ||
        !segment.openDate ||
        segment.startStationId === segment.endStationId
    );

    if (hasInvalid) {
      Modal.warning({
        title: '请完善信息',
        content: '每一行都需要选择线路、起点、终点与开通日期，且起终点不能相同。'
      });
      return;
    }

    onConfirm({
      segments: sortedSegments,
      title: title.trim() || '城市轨道线网历程',
      subtitle: subtitle.trim(),
      titleDurationSec: Math.max(1, Math.min(8, titleDurationSec || DEFAULT_TITLE_DURATION_SEC))
    });
  };

  return (
    <DraggableModal
      title="导出动态演示视频"
      open={open}
      onCancel={onCancel}
      footer={null}
      width={720}
      bodyStyle={{ paddingTop: 12, paddingBottom: 12 }}
    >
      <Alert
        type="info"
        message="请按开通日期先后填写各个区间，导出时会按时间顺序生成动态演示。"
        style={{ marginBottom: 12 }}
      />

      {/* 片头自定义：主+副+时长。折一个浅色盒子里跟下面的区间表区隔。 */}
      <div
        style={{
          border: '1px solid #d9e2f2',
          borderRadius: 12,
          padding: 12,
          marginBottom: 12,
          background: '#f9fbff'
        }}
      >
        <Text strong style={{ display: 'block', marginBottom: 8 }}>片头</Text>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 130px', gap: 8 }}>
          <Form.Item label="主标题" style={{ marginBottom: 0 }}>
            <Input
              placeholder="例：北京轨道交通线网历程"
              value={title}
              maxLength={32}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Form.Item>
          <Form.Item label="副标题（可选）" style={{ marginBottom: 0 }}>
            <Input
              placeholder="例：1969 - 2024"
              value={subtitle}
              maxLength={48}
              onChange={(e) => setSubtitle(e.target.value)}
            />
          </Form.Item>
          <Form.Item label="片头停留 (秒)" style={{ marginBottom: 0 }}>
            <InputNumber
              min={1}
              max={8}
              step={0.5}
              value={titleDurationSec}
              onChange={(value) => setTitleDurationSec(Number(value) || DEFAULT_TITLE_DURATION_SEC)}
              style={{ width: '100%' }}
            />
          </Form.Item>
        </div>
      </div>

      <Space
        direction="vertical"
        style={{ width: '100%', maxHeight: 460, minHeight: 280, overflowY: 'auto', paddingRight: 4 }}
        size="middle"
      >
        {sortedSegments.map((segment, index) => (
          <div
            key={segment.id}
            style={{
              border: '1px solid #d9e2f2',
              borderRadius: 12,
              padding: 12,
              display: 'grid',
              gridTemplateColumns: '88px 1fr auto',
              gap: 12,
              alignItems: 'start',
              background: '#f9fbff'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', minHeight: 32 }}>
              <Text type="secondary">步骤 {index + 1}</Text>
            </div>

            <Form layout="vertical" style={{ margin: 0 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                <Form.Item label="线路" required style={{ marginBottom: 8 }}>
                  <Select
                    options={lineOptions}
                    placeholder="选择线路"
                    value={segment.lineId || undefined}
                    onChange={(value) =>
                      handleChange(segment.id, { lineId: value, startStationId: '', endStationId: '' })
                    }
                  />
                </Form.Item>
                <Form.Item label="起点站" required style={{ marginBottom: 8 }}>
                  <Select
                    options={getStationOptions(segment.lineId)}
                    placeholder="选择起点"
                    value={segment.startStationId || undefined}
                    onChange={(value) => handleChange(segment.id, { startStationId: value })}
                    disabled={!segment.lineId}
                  />
                </Form.Item>
                <Form.Item label="终点站" required style={{ marginBottom: 8 }}>
                  <Select
                    options={getStationOptions(segment.lineId)}
                    placeholder="选择终点"
                    value={segment.endStationId || undefined}
                    onChange={(value) => handleChange(segment.id, { endStationId: value })}
                    disabled={!segment.lineId}
                  />
                </Form.Item>
              </div>

              <Form.Item label="开通日期" required style={{ marginBottom: 0 }}>
                <Input
                  type="date"
                  value={segment.openDate}
                  onChange={(e) => handleChange(segment.id, { openDate: e.target.value })}
                />
              </Form.Item>
            </Form>

            <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 4 }}>
              <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDeleteRow(segment.id)} />
            </div>
          </div>
        ))}

        <Button type="dashed" block icon={<PlusOutlined />} onClick={handleAddRow}>
          新增区间
        </Button>

        <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
          <Button onClick={onCancel}>取消</Button>
          <Button type="primary" onClick={handleConfirm}>
            完成并导出
          </Button>
        </Space>
      </Space>
    </DraggableModal>
  );
};

export default VideoExportModal;
