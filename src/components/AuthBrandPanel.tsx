import React from 'react';

const features = [
  '多线路并行设计，颜色与走向一目了然',
  '拖拽站点、调整线路，实时预览效果',
  '高清导出静态图与动态演示'
];

const AuthBrandPanel: React.FC = () => (
  <div className="auth-brand-panel">
    <div className="auth-brand-badge">
      <svg width="22" height="24" viewBox="0 0 24 26" fill="none" aria-hidden="true" focusable="false">
        <rect x="4" y="2" width="16" height="18" rx="4" stroke="currentColor" strokeWidth="1.7" />
        <rect x="7" y="6" width="10" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="8" cy="16" r="1.3" fill="currentColor" />
        <circle cx="16" cy="16" r="1.3" fill="currentColor" />
        <path d="m8 20-3 4m11-4 3 4M7 23h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
      <span>METRO DESIGNER</span>
    </div>

    <div className="auth-brand-copy">
      <h2 className="auth-brand-title">
        <span>设计更像<span className="auth-brand-title__accent">地铁系统</span></span>
        <span>而不是普通流程图</span>
      </h2>
      <div className="auth-brand-palette" aria-hidden="true">
        <span /><span /><span /><span />
      </div>
      <p className="auth-brand-subtitle">
        多线路绘制、站点管理、换乘编排，一键导出 PNG / WebM。
      </p>
      <ul className="auth-brand-features">
        {features.map(feature => (
          <li className="auth-brand-feature" key={feature}>
            <span className="auth-brand-feature__dot" aria-hidden="true" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      {!navigator.userAgent.includes('MetroDesignerDesktop/') && (
        <a className="auth-brand-download" href="/downloads.html">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M1 3.5 8.5 2.4v7H1zm8.5-1.3L19 1v8.4H9.5zM1 10.5h7.5v7L1 16.4zm8.5 0H19V19l-9.5-1.3z" />
          </svg>
          下载 Windows 客户端 <span aria-hidden="true">↗</span>
        </a>
      )}
    </div>

    <div className="auth-brand-map" aria-hidden="true">
      <div className="auth-brand-map__glow" />
      <svg className="auth-brand-map__svg" viewBox="0 0 620 330" fill="none" focusable="false" aria-hidden="true">
        <g strokeWidth="10" strokeLinecap="round" strokeLinejoin="round">
          <path className="auth-brand-route auth-brand-route--cyan" pathLength="1"
            d="M16 160H328Q344 160 356 148L412 92Q424 80 440 80H620" />
          <path className="auth-brand-route auth-brand-route--orange" pathLength="1"
            d="M108 8 228 128Q240 140 240 156V236Q240 252 256 252H570" />
          <path className="auth-brand-route auth-brand-route--green" pathLength="1"
            d="M430 110V280Q430 296 446 296H620" />
        </g>
        <g fill="white">
          <g className="auth-brand-stations auth-brand-stations--cyan">
            <circle cx="66" cy="160" r="5" /><circle cx="150" cy="160" r="5" /><circle cx="500" cy="80" r="5" />
          </g>
          <g className="auth-brand-stations auth-brand-stations--orange">
            <circle cx="155" cy="55" r="5" /><circle cx="240" cy="212" r="5" /><circle cx="335" cy="252" r="5" />
          </g>
          <g className="auth-brand-stations auth-brand-stations--green">
            <circle cx="430" cy="145" r="5" /><circle cx="530" cy="296" r="5" />
          </g>
          <g className="auth-brand-stations auth-brand-stations--transfer" stroke="#102C61" strokeWidth="4">
            <circle cx="240" cy="160" r="11" /><circle cx="430" cy="252" r="11" />
          </g>
        </g>
      </svg>
      <span className="auth-brand-map__label auth-brand-map__label--start">起点站</span>
      <span className="auth-brand-map__label auth-brand-map__label--transfer">换乘站</span>
      <span className="auth-brand-map__label auth-brand-map__label--square">设计广场</span>
      <span className="auth-brand-map__label auth-brand-map__label--end">终点站</span>
    </div>
  </div>
);

export default AuthBrandPanel;
