import React, { useState } from 'react';
import { Button } from 'antd';
import { GlobalOutlined, PlusOutlined } from '@ant-design/icons';

interface CanvasStartPromptProps {
  language: 'zh-CN' | 'en-US';
  onCreateLine: () => void;
  onStartWithAmap: () => void;
}

const CanvasStartPrompt: React.FC<CanvasStartPromptProps> = ({ language, onCreateLine, onStartWithAmap }) => {
  const english = language === 'en-US';
  const [artReady, setArtReady] = useState(false);
  return (
    <section className="metro-canvas-start" aria-labelledby="canvas-start-title">
      <div className="metro-canvas-start__content">
        <img className={`metro-canvas-start__art${artReady ? ' is-ready' : ''}`} src={`${process.env.PUBLIC_URL}/canvas-start-network.png`}
          width={216} height={112} alt="" draggable={false} onLoad={() => setArtReady(true)} />
        <h1 id="canvas-start-title">{english ? 'Start with your first line' : '从第一条线路开始'}</h1>
        <p>{english ? 'Create a line, or start drawing on a real map.' : '新建线路，或在真实地图上开始绘制'}</p>
        <div className="metro-canvas-start__actions">
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreateLine}>
            {english ? 'New line' : '新建线路'}
          </Button>
          <Button icon={<GlobalOutlined />} onClick={onStartWithAmap}>
            {english ? 'Use AMap basemap' : '导入高德底图'}
          </Button>
        </div>
      </div>
    </section>
  );
};

export default CanvasStartPrompt;
