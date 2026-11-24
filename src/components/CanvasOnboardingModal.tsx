import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CheckOutlined,
  CloseOutlined
} from '@ant-design/icons';

export const CANVAS_ONBOARDING_STORAGE_KEY = 'metro_canvas_onboarding_v2_seen';

export function hasSeenCanvasOnboarding(): boolean {
  try {
    return window.localStorage.getItem(CANVAS_ONBOARDING_STORAGE_KEY) === '1';
  } catch {
    return true;
  }
}

export function markCanvasOnboardingSeen(): void {
  try {
    window.localStorage.setItem(CANVAS_ONBOARDING_STORAGE_KEY, '1');
  } catch {
    /* ignore */
  }
}

interface CanvasOnboardingModalProps {
  open: boolean;
  initialView?: 'tour' | 'cheatsheet';
  isCompact?: boolean;
  language?: 'zh-CN' | 'en-US';
  onClose: () => void;
}

const TourIllustration: React.FC<{ step: number }> = ({ step }) => {
  if (step === 0) {
    // Step 1: 连续建站 + 右键抬笔换方向/拉支线
    return (
      <svg className="metro-onboard-svg" viewBox="0 0 360 156" aria-hidden="true">
        <defs>
          <pattern id="onbGrid0" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1" fill="#cbd5e1" opacity="0.6" />
          </pattern>
        </defs>
        <rect width="360" height="156" rx="12" fill="#f8fafc" />
        <rect width="360" height="156" rx="12" fill="url(#onbGrid0)" />
        {/* 主干线 A - B - C */}
        <path d="M 52 96 L 156 96 L 264 96" stroke="#2563eb" strokeWidth="5" strokeLinecap="round" fill="none" />
        {/* 从中间站 B 拉出的支线预览 */}
        <path
          className="metro-onboard-anim-dash"
          d="M 156 96 L 226 42"
          stroke="#2563eb"
          strokeWidth="3.5"
          strokeDasharray="6 6"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="52" cy="96" r="7" fill="#2563eb" stroke="#ffffff" strokeWidth="2.5" />
        <circle cx="156" cy="96" r="11" fill="none" stroke="#3b82f6" strokeWidth="2" opacity="0.45" className="metro-onboard-anim-pulse" />
        <circle cx="156" cy="96" r="7.5" fill="#ffffff" stroke="#0f172a" strokeWidth="2.5" />
        <circle cx="264" cy="96" r="7" fill="#2563eb" stroke="#ffffff" strokeWidth="2.5" />
        <circle cx="226" cy="42" r="6.5" fill="#93c5fd" stroke="#2563eb" strokeWidth="2" strokeDasharray="3 2" />
        <text x="52" y="120" textAnchor="middle" fontSize="11" fontWeight="600" fill="#334155">起点站</text>
        <text x="156" y="120" textAnchor="middle" fontSize="11" fontWeight="700" fill="#1d4ed8">点此起笔拉支线</text>
        <text x="264" y="120" textAnchor="middle" fontSize="11" fontWeight="600" fill="#334155">右键抬笔</text>
        <rect x="234" y="26" width="84" height="22" rx="11" fill="#eff6ff" stroke="#bfdbfe" />
        <text x="276" y="41" textAnchor="middle" fontSize="10.5" fontWeight="600" fill="#1d4ed8">左键继续连站</text>
      </svg>
    );
  }

  if (step === 1) {
    // Step 2: 360° 自由途经点 + 就地拉圆弧手柄
    return (
      <svg className="metro-onboard-svg" viewBox="0 0 360 156" aria-hidden="true">
        <rect width="360" height="156" rx="12" fill="#f8fafc" />
        {/* 原始折角虚线 */}
        <path d="M 56 116 L 176 34 L 304 116" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="4 4" fill="none" />
        {/* 导圆角后的平滑大圆弧 */}
        <path
          d="M 56 116 L 122 71 Q 176 34 230 71 L 304 116"
          stroke="#e11d48"
          strokeWidth="5"
          strokeLinecap="round"
          fill="none"
        />
        {/* 角平分线圆弧拉杆 */}
        <line x1="176" y1="34" x2="176" y2="62" stroke="#f59e0b" strokeWidth="2" strokeDasharray="3 3" />
        <circle cx="56" cy="116" r="7" fill="#e11d48" stroke="#ffffff" strokeWidth="2.5" />
        <circle cx="304" cy="116" r="7" fill="#e11d48" stroke="#ffffff" strokeWidth="2.5" />
        {/* 途经点与圆弧手柄 */}
        <circle cx="176" cy="34" r="6" fill="#ffffff" stroke="#2563eb" strokeWidth="2.2" />
        <circle cx="176" cy="62" r="6.5" fill="#f59e0b" stroke="#ffffff" strokeWidth="2" className="metro-onboard-anim-bob" />
        <rect x="192" y="50" width="128" height="24" rx="12" fill="#fffbeb" stroke="#fde68a" />
        <text x="256" y="66" textAnchor="middle" fontSize="10.5" fontWeight="600" fill="#b45309">拖拉杆调圆弧半径 / 过点弧</text>
      </svg>
    );
  }

  if (step === 2) {
    // Step 3: 双击快改（改站名 / 线段补站 / 删拐点）
    return (
      <svg className="metro-onboard-svg" viewBox="0 0 360 156" aria-hidden="true">
        <rect width="360" height="156" rx="12" fill="#f8fafc" />
        <path d="M 48 96 L 180 96 L 312 96" stroke="#0d9488" strokeWidth="5" strokeLinecap="round" fill="none" />
        <circle cx="48" cy="96" r="7" fill="#0d9488" stroke="#ffffff" strokeWidth="2.5" />
        <circle cx="180" cy="96" r="8" fill="#ffffff" stroke="#0d9488" strokeWidth="3" />
        <circle cx="312" cy="96" r="7" fill="#0d9488" stroke="#ffffff" strokeWidth="2.5" />
        {/* 原地改名胶囊示意 */}
        <rect x="116" y="42" width="128" height="32" rx="10" fill="#ffffff" stroke="#3b82f6" strokeWidth="1.6" />
        <text x="168" y="62" textAnchor="middle" fontSize="12" fontWeight="600" fill="#0f172a">人民广场</text>
        <rect x="208" y="48" width="28" height="20" rx="6" fill="#eff6ff" />
        <text x="222" y="62" textAnchor="middle" fontSize="10" fontWeight="700" fill="#2563eb">EN</text>
        <text x="180" y="124" textAnchor="middle" fontSize="11" fontWeight="600" fill="#334155">双击线段补站 · 双击站点原地改名</text>
      </svg>
    );
  }

  // Step 4: 框选整片平移 + 空格抓手 + Ctrl+F 搜站
  return (
    <svg className="metro-onboard-svg" viewBox="0 0 360 156" aria-hidden="true">
      <rect width="360" height="156" rx="12" fill="#f8fafc" />
      <rect
        x="76"
        y="30"
        width="172"
        height="92"
        rx="8"
        fill="rgba(37, 99, 235, 0.08)"
        stroke="#3b82f6"
        strokeWidth="1.5"
        strokeDasharray="5 4"
      />
      <path d="M 98 78 L 162 56 L 222 86" stroke="#7c3aed" strokeWidth="4.5" strokeLinecap="round" fill="none" />
      <circle cx="98" cy="78" r="7" fill="#7c3aed" stroke="#ffffff" strokeWidth="2" />
      <circle cx="98" cy="78" r="11" fill="none" stroke="#3b82f6" strokeWidth="1.8" />
      <circle cx="162" cy="56" r="7" fill="#7c3aed" stroke="#ffffff" strokeWidth="2" />
      <circle cx="162" cy="56" r="11" fill="none" stroke="#3b82f6" strokeWidth="1.8" />
      <circle cx="222" cy="86" r="7" fill="#7c3aed" stroke="#ffffff" strokeWidth="2" />
      <circle cx="222" cy="86" r="11" fill="none" stroke="#3b82f6" strokeWidth="1.8" />
      <rect x="258" y="48" width="84" height="26" rx="8" fill="#ffffff" stroke="#cbd5e1" />
      <text x="300" y="65" textAnchor="middle" fontSize="11" fontWeight="700" fill="#334155">Space 抓手</text>
      <rect x="258" y="82" width="84" height="26" rx="8" fill="#ffffff" stroke="#cbd5e1" />
      <text x="300" y="99" textAnchor="middle" fontSize="11" fontWeight="700" fill="#334155">Ctrl+F 搜站</text>
    </svg>
  );
};

const CanvasOnboardingModal: React.FC<CanvasOnboardingModalProps> = ({
  open,
  initialView = 'tour',
  isCompact = false,
  language = 'zh-CN',
  onClose
}) => {
  const [view, setView] = useState<'tour' | 'cheatsheet'>(initialView);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (open) {
      setView(initialView);
      setStep(0);
    }
  }, [open, initialView]);

  const isEn = language === 'en-US';

  const tourSteps = isEn
    ? [
        {
          badge: '1 / 4 · Continuous Pen',
          title: 'Click to extend, Right-click to lift pen & branch',
          points: [
            'In Draw (D) mode, click blank canvas to place stations and connect automatically.',
            'Hold Shift + Click (or toggle "Waypoint") while drawing to place 360° free bends.',
            'Right-click or press Esc to lift the pen — then click ANY station to extend the other end or pull a branch.'
          ]
        },
        {
          badge: '2 / 4 · 360° Curves & Arcs',
          title: 'Drag any track to bend, click a bend to pull an arc',
          points: [
            'In Select (V) mode, drag anywhere on a line segment to pull out a 360° waypoint in exact segment order.',
            'Click any waypoint to drag its inner Arc Handle for custom corner radius, or switch to 3-Point Pure Arc.'
          ]
        },
        {
          badge: '3 / 4 · Fast Inline Edits',
          title: 'Double-click to rename, insert, or straighten',
          points: [
            'Double-click a station to rename inline without blocking modals.',
            'Double-click a line segment to split it and insert an intermediate station.',
            'Double-click a waypoint to remove it; drag one station onto another to merge into an interchange.'
          ]
        },
        {
          badge: '4 / 4 · Box Select & Navigation',
          title: 'Marquee group move, Space pan & Ctrl+F search',
          points: [
            'Drag on blank canvas in Select mode to box-select and move an entire sub-network together.',
            'Hold Space + drag (or middle-mouse drag) to pan anytime; press Ctrl+F to find and jump to any station.'
          ]
        }
      ]
    : [
        {
          badge: '1 / 4 · 钢笔连续绘制与抬笔',
          title: '左键一路连站，右键「抬笔」换另一头或拉支线',
          points: [
            '在「绘制 (D)」模式下点空白处直接落站并自动连线，无需弹窗确认即可连续点下一站。',
            '连笔途中按住 Shift + 左键（或点顶部「拐点」开关），可沿河道/街区自由打任意多个 360° 途经点。',
            '右键单击或按 Esc 即可「抬笔」收起虚线，随后点任意已有站点就能从另一端延伸或拉出支线；点本线站自动闭合环线。'
          ]
        },
        {
          badge: '2 / 4 · 360° 自由塑形与就地画圆弧',
          title: '按住线段任意处拖出拐点，单击拐点直接拉圆弧',
          points: [
            '在「选择 (V)」模式下，直接按住区间任意位置往外拖即可插入途经点——点在哪一小段就精准插在哪一段，绝不乱序。',
            '单击任意途经点，可直接拖动内侧「圆弧拉杆」自由调节该弯道半径，或一键切换「过点正圆弧」画出标准弧线。'
          ]
        },
        {
          badge: '3 / 4 · 双击快改与换乘合并',
          title: '双击改名、双击线段补站、拖站叠放合换乘',
          points: [
            '双击站点：原地呼出轻量输入框改名（内置 AI 英文翻译），不打断视线。',
            '双击区间线段：在点击处无损把区间一分为二并插入中间站；双击途经点：一键删除拉直。',
            '将站点拖到另一条线的站点圆心上松手，可直接合并为换乘枢纽。'
          ]
        },
        {
          badge: '4 / 4 · 框选群移与全局效率手势',
          title: '拉框整片平移 · 空格随时抓手 · Ctrl+F 搜站',
          points: [
            '在「选择 (V)」模式空白处拖拽可拉框多选，拖动任意选中站即可连同内部途经点整片平移，按 Delete 批量删站。',
            '在任何模式下按住「空格键」左键拖（或鼠标中键拖）随时平移画布；按 Ctrl+F 快速搜索定位站点。'
          ]
        }
      ];

  const shortcutGroups = isCompact
    ? [
        {
          title: isEn ? 'Touch Navigation' : '触屏视图与选择',
          items: [
            { k: isEn ? '2 Fingers' : '双指捏合 / 拖动', d: isEn ? 'Zoom & pan canvas anytime' : '任意模式下随时缩放与平移画布' },
            { k: isEn ? 'Tap Station' : '点按站点 / 长按', d: isEn ? 'Open station actions & label menu' : '唤出站点操作、改名与站名方位菜单' },
            { k: isEn ? 'Drag Track' : '选择模式拖线段', d: isEn ? 'Pull out a 360° bend' : '在所按线段处拉出 360° 途经点' },
            { k: isEn ? 'Tap Waypoint' : '点按途经点', d: isEn ? 'Adjust arc radius or 3-point arc' : '拖动圆弧手柄调半径或切过点圆弧' }
          ]
        },
        {
          title: isEn ? 'Continuous Drawing' : '连续绘制模式',
          items: [
            { k: isEn ? 'Tap Blank' : '点空白处', d: isEn ? 'Add station & auto-connect' : '连续落站并自动连线（拐点开关开启时打途经点）' },
            { k: isEn ? 'Tap Station' : '点已有站点', d: isEn ? 'Start from it or connect transfer/loop' : '未起笔时从该站出发；连笔中接入换乘或闭环' },
            { k: isEn ? 'Lift Pen' : '点「抬笔」按钮', d: isEn ? 'Detach chain to switch ends/branch' : '结束当前连笔，方便换另一端延伸或拉支线' }
          ]
        }
      ]
    : [
        {
          title: isEn ? 'Drawing & Shaping' : '连续绘制与圆弧塑形',
          items: [
            { k: 'D / V / H', d: isEn ? 'Switch Draw / Select / Pan mode' : '切换「绘制 / 选择 / 移动」三大模式' },
            { k: isEn ? 'Left Click' : '绘制态 · 左键', d: isEn ? 'Place station / connect transfer / split line' : '落新站连线 · 点已有站换乘/闭环 · 点线段T字插站' },
            { k: 'Shift + 左键', d: isEn ? 'Add 360° waypoint while drawing' : '连笔途中打 360° 自由途经点（可连续打多个）' },
            { k: isEn ? 'Right Click / Esc' : '绘制态 · 右键 / Esc', d: isEn ? 'Lift pen to switch ends or branch' : '抬笔断链（不退出绘制），再点任意站延伸或拉支线' },
            { k: isEn ? 'Drag Segment' : '选择态 · 拖线段', d: isEn ? 'Insert & drag 360° waypoint' : '在所抓位置直接拉出途经点，单击途经点调圆弧' },
            { k: 'Alt (按住)', d: isEn ? 'Bypass angle snap / station merge' : '临时关闭角度参考吸附与站点叠放合并' }
          ]
        },
        {
          title: isEn ? 'Fast Edits & Navigation' : '快改、多选与全局导航',
          items: [
            { k: isEn ? 'Double Click' : '双击站点 / 线段 / 拐点', d: isEn ? 'Inline rename / insert station / delete bend' : '原地改站名 · 劈开区间补站 · 删除拐点拉直' },
            { k: isEn ? 'Blank Drag' : '选择态 · 空白拖拽', d: isEn ? 'Marquee box-select & group move' : '矩形框选多站（连同内部拐点整片平移）' },
            { k: 'Space + 拖拽', d: isEn ? 'Temporary hand pan in any tool' : '任意工具下临时抓手平移画布（同鼠标中键）' },
            { k: 'Ctrl / ⌘ + F', d: isEn ? 'Search & jump to station' : '快速搜索站名/线路并平滑居中定位' },
            { k: 'Delete / ⌫', d: isEn ? 'Delete selected stations or waypoint' : '删除框选站点（自动缝合中间站）或选中拐点' },
            { k: 'Ctrl / ⌘ + Z', d: isEn ? 'Undo / Redo (+ Shift)' : '撤销上一步操作（Ctrl+Shift+Z 重做）' }
          ]
        }
      ];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        markCanvasOnboardingSeen();
        onClose();
      } else if (view === 'tour' && e.key === 'ArrowRight') {
        setStep((s) => Math.min(3, s + 1));
      } else if (view === 'tour' && e.key === 'ArrowLeft') {
        setStep((s) => Math.max(0, s - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, view, onClose]);

  const handleFinish = () => {
    markCanvasOnboardingSeen();
    onClose();
  };

  if (!open || typeof document === 'undefined') return null;

  const currentTour = tourSteps[step];

  return createPortal(
    <div
      className="metro-onboarding-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={isEn ? 'Canvas Gesture Guide' : '画布手势与操作指南'}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleFinish();
      }}
    >
      <div
        className={`metro-onboard-dialog${view === 'cheatsheet' ? ' is-wide' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
      <div className="metro-onboard">
        <div className="metro-onboard__header">
          <div className="metro-onboard__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'tour'}
              className={`metro-onboard__tab${view === 'tour' ? ' is-active' : ''}`}
              onClick={() => setView('tour')}
            >
              {isEn ? 'Interactive Guide' : '4 步上手演示'}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'cheatsheet'}
              className={`metro-onboard__tab${view === 'cheatsheet' ? ' is-active' : ''}`}
              onClick={() => setView('cheatsheet')}
            >
              {isEn ? 'Gestures & Shortcuts' : '全部手势与快捷键'}
            </button>
          </div>
          <button
            type="button"
            className="metro-onboard__close"
            onClick={handleFinish}
            aria-label={isEn ? 'Close guide' : '关闭引导'}
          >
            <CloseOutlined />
          </button>
        </div>

        {view === 'tour' ? (
          <div className="metro-onboard__tour">
            <TourIllustration step={step} />
            <div className="metro-onboard__badge">{currentTour.badge}</div>
            <h3 className="metro-onboard__title">{currentTour.title}</h3>
            <ul className="metro-onboard__list">
              {currentTour.points.map((pt, idx) => (
                <li key={idx}>{pt}</li>
              ))}
            </ul>

            <div className="metro-onboard__footer">
              <div className="metro-onboard__dots" role="tablist" aria-label="Guide steps">
                {tourSteps.map((_, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className={`metro-onboard__dot${idx === step ? ' is-active' : ''}`}
                    onClick={() => setStep(idx)}
                    aria-label={`Step ${idx + 1}`}
                  />
                ))}
              </div>
              <div className="metro-onboard__actions">
                {step > 0 ? (
                  <button
                    type="button"
                    className="metro-onboard__btn metro-onboard__btn--ghost"
                    onClick={() => setStep((s) => Math.max(0, s - 1))}
                  >
                    <ArrowLeftOutlined /> {isEn ? 'Back' : '上一步'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="metro-onboard__btn metro-onboard__btn--ghost"
                    onClick={handleFinish}
                  >
                    {isEn ? 'Skip' : '跳过'}
                  </button>
                )}
                {step < tourSteps.length - 1 ? (
                  <button
                    type="button"
                    className="metro-onboard__btn metro-onboard__btn--primary"
                    onClick={() => setStep((s) => Math.min(tourSteps.length - 1, s + 1))}
                  >
                    {isEn ? 'Next' : '下一步'} <ArrowRightOutlined />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="metro-onboard__btn metro-onboard__btn--primary"
                    onClick={handleFinish}
                  >
                    <CheckOutlined /> {isEn ? 'Start Designing' : '开始绘制'}
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="metro-onboard__sheet">
            <div className="metro-onboard__grid">
              {shortcutGroups.map((group) => (
                <div key={group.title} className="metro-onboard__group">
                  <div className="metro-onboard__group-title">{group.title}</div>
                  {group.items.map((item) => (
                    <div key={item.k} className="metro-onboard__row">
                      <kbd className="metro-onboard__kbd">{item.k}</kbd>
                      <span className="metro-onboard__desc">{item.d}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="metro-onboard__sheet-footer">
              <button
                type="button"
                className="metro-onboard__btn metro-onboard__btn--primary"
                onClick={handleFinish}
              >
                {isEn ? 'Got it' : '我知道了'}
              </button>
            </div>
          </div>
        )}
      </div>
      </div>
    </div>,
    document.body
  );
};

export default CanvasOnboardingModal;
