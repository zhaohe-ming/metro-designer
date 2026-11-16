import React, { useId } from 'react';
import { isDesktopClient } from '../lib/desktopClient';

const AuthBrandPanel: React.FC = () => {
  const id = `auth-map-${useId().replace(/:/g, '')}`;
  return (
    <div className="auth-brand-panel">
      <div className="auth-brand-badge">
        <svg width="22" height="24" viewBox="0 0 24 26" fill="none" aria-hidden="true" focusable="false">
          <rect x="4" y="2" width="16" height="18" rx="4" stroke="currentColor" strokeWidth="1.7" />
          <rect x="7" y="6" width="10" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="8" cy="16" r="1.3" fill="currentColor" /><circle cx="16" cy="16" r="1.3" fill="currentColor" />
          <path d="m8 20-3 4m11-4 3 4M7 23h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        <span>METRO DESIGNER</span>
      </div>
      <div className="auth-brand-copy">
        <h2 className="auth-brand-title"><span>从一条线路开始，</span><span>画出整座城市的地铁图。</span></h2>
        <div className="auth-brand-palette" aria-hidden="true"><span /><span /><span /><span /></div>
        {!isDesktopClient && (
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
        <svg className="auth-brand-map__svg" viewBox="0 0 620 370" fill="none" focusable="false" aria-hidden="true">
          <defs>
            <linearGradient id={`${id}-top`} gradientUnits="userSpaceOnUse" x1="0" y1="35" x2="0" y2="78">
              <stop stopColor="white" stopOpacity="0" /><stop offset="1" stopColor="white" />
            </linearGradient>
            <mask id={`${id}-fade`} x="0" y="0" width="620" height="370" maskUnits="userSpaceOnUse">
              <rect width="620" height="370" fill={`url(#${id}-top)`} />
            </mask>
            <linearGradient id={`${id}-orange-top`} gradientUnits="userSpaceOnUse" x1="0" y1="58" x2="0" y2="112">
              <stop stopColor="white" stopOpacity="0" /><stop offset="1" stopColor="white" />
            </linearGradient>
            <mask id={`${id}-orange-fade`} x="0" y="0" width="620" height="370" maskUnits="userSpaceOnUse">
              <rect width="620" height="370" fill={`url(#${id}-orange-top)`} />
            </mask>
            <linearGradient id={`${id}-orange`} gradientUnits="userSpaceOnUse" x1="150" y1="0" x2="594" y2="0">
              <stop stopColor="var(--metro-line-orange)" /><stop offset="0.79" stopColor="var(--metro-line-orange)" />
              <stop offset="1" stopColor="var(--metro-line-orange)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <g strokeWidth="10" strokeLinecap="round" strokeLinejoin="round">
            <path className="auth-brand-route auth-brand-route--cyan" pathLength="1"
              d="M84 212H344Q360 212 372 200L428 144Q440 132 456 132H570" />
            <g mask={`url(#${id}-fade)`}>
              <path className="auth-brand-route auth-brand-route--orange" pathLength="1" stroke={`url(#${id}-orange)`} mask={`url(#${id}-orange-fade)`}
                d="M150 20 266 136Q276 146 276 162V286Q276 304 294 304H594" />
              <path className="auth-brand-route auth-brand-route--green" pathLength="1" d="M472 0V344" />
            </g>
          </g>
          <g fill="white">
            <g className="auth-brand-stations auth-brand-stations--cyan">
              <circle cx="84" cy="212" r="6" /><circle cx="144" cy="212" r="5" />
              <circle cx="205" cy="212" r="5" /><circle cx="570" cy="132" r="6" />
            </g>
            <g className="auth-brand-stations auth-brand-stations--orange" mask={`url(#${id}-orange-fade)`}>
              <circle cx="196" cy="66" r="5" /><circle cx="276" cy="264" r="5" /><circle cx="374" cy="304" r="5" />
            </g>
            <g className="auth-brand-stations auth-brand-stations--green">
              <circle cx="472" cy="78" r="5" /><circle cx="472" cy="192" r="5" />
            </g>
            <g className="auth-brand-stations auth-brand-stations--transfer" stroke="#102C61" strokeWidth="4">
              <circle cx="276" cy="212" r="11" /><circle cx="472" cy="132" r="11" /><circle cx="472" cy="304" r="11" />
            </g>
          </g>
        </svg>
        <span className="auth-brand-map__label auth-brand-map__label--start">起点站</span>
        <span className="auth-brand-map__label auth-brand-map__label--transfer">换乘站</span>
        <span className="auth-brand-map__label auth-brand-map__label--end">终点站</span>
      </div>
    </div>
  );
};
export default AuthBrandPanel;
