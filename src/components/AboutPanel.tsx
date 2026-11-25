import React from 'react';
import { Button } from 'antd';
import { MailOutlined, UserOutlined } from '@ant-design/icons';
import { androidVersion } from '../lib/androidClient';
import { desktopVersion } from '../lib/desktopClient';
import DraggableModal from './DraggableModal';

interface AboutPanelProps {
  language: 'zh-CN' | 'en-US';
  onClose: () => void;
  onOpenProfile: () => void;
}

const AboutPanel: React.FC<AboutPanelProps> = ({ language, onClose, onOpenProfile }) => {
  const en = language === 'en-US';
  return <DraggableModal open title={en ? 'About Metro Designer' : '关于我们'} onCancel={onClose}
    width={560} className="metro-about" footer={<Button onClick={onClose}>{en ? 'Close' : '关闭'}</Button>}>
    <div className="metro-about__brand"><img src="/favicon.svg" alt="" width={40} height={40} />
      <div><h2>Metro Designer</h2><p>{en ? 'Design a city, one line at a time.' : '从一条线路开始，画出整座城市的地铁图。'}</p></div></div>
    <p className="metro-about__intro">{en ? 'Draw lines, manage stations and interchanges, and export maps and animated demos.' : '多线路绘制、站点管理、换乘编排，导出地图与动态演示。'}</p>
    <dl className="metro-about__versions">
      <div><dt>{en ? 'Platform' : '当前平台'}</dt><dd>{androidVersion ? 'Android' : desktopVersion ? 'Windows' : (en ? 'Web' : '网页版')}</dd></div>
      {(androidVersion || desktopVersion) && <div><dt>{en ? 'App version' : '客户端版本'}</dt><dd>v{androidVersion || desktopVersion}</dd></div>}
      <div><dt>{en ? 'Web update' : '网页更新'}</dt><dd>2026-11-17</dd></div>
    </dl>
    <details className="metro-about__changes"><summary>{en ? 'What’s new' : '更新记录'}</summary>
      <ul><li>{en ? 'Open geographic basemap styles and remembered selection.' : '支持免密钥四风格地理底图预览与上次选择记忆。'}</li>
        <li>{en ? 'New canvas start actions and mobile interactions.' : '优化空白画布开始入口和移动端操作。'}</li>
        <li>{en ? 'Product information and privacy resources.' : '补充产品信息、隐私与使用说明入口。'}</li></ul></details>
    <nav className="metro-about__links" aria-label={en ? 'Product information' : '产品信息'}>
      <a href="/privacy.html" target="_blank" rel="noopener noreferrer">{en ? 'Privacy & data' : '隐私与数据说明'}<span aria-hidden="true">↗</span></a>
      <a href="/terms.html" target="_blank" rel="noopener noreferrer">{en ? 'Terms & your work' : '用户协议与作品说明'}<span aria-hidden="true">↗</span></a>
      <a href="/third-party.html" target="_blank" rel="noopener noreferrer">{en ? 'Third-party services & licenses' : '第三方服务与开源许可'}<span aria-hidden="true">↗</span></a>
      <button type="button" onClick={onOpenProfile}><span><UserOutlined /> {en ? 'Account & data' : '账号与数据'}</span><span aria-hidden="true">→</span></button>
    </nav>
    <div className="metro-about__contact"><MailOutlined /><a href="mailto:3855166698@qq.com">3855166698@qq.com</a></div>
    <p className="metro-about__foot">{en ? 'For account deletion or data requests, contact us using your registered email.' : '账号注销、数据导出或删除申请，可通过注册邮箱联系。'}</p>
    <p className="metro-about__foot">© 2026 Metro Designer</p>
  </DraggableModal>;
};

export default AboutPanel;
