import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CheckOutlined,
  CloseOutlined
} from '@ant-design/icons';
import ElasticCapsuleTabs from './ElasticCapsuleTabs';

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
    return (
      <svg className="metro-onboard-svg" viewBox="0 0 380 160" aria-hidden="true">
        <defs>
          <pattern id="onbGrid0" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1" fill="#cbd5e1" opacity="0.6" />
          </pattern>
        </defs>
        <rect width="380" height="160" rx="12" fill="#f8fafc" />
        <rect width="380" height="160" rx="12" fill="url(#onbGrid0)" />
        <path d="M 56 98 L 166 98 L 280 98" stroke="#2563eb" strokeWidth="5" strokeLinecap="round" fill="none" />
        <path
          className="metro-onboard-anim-dash"
          d="M 166 98 L 240 42"
          stroke="#2563eb"
          strokeWidth="3.5"
          strokeDasharray="6 6"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="56" cy="98" r="7" fill="#2563eb" stroke="#ffffff" strokeWidth="2.5" />
        <circle
          cx="166"
          cy="98"
          r="11.5"
          fill="none"
          stroke="#3b82f6"
          strokeWidth="2"
          opacity="0.45"
          className="metro-onboard-anim-pulse"
        />
        <circle cx="166" cy="98" r="7.5" fill="#ffffff" stroke="#0f172a" strokeWidth="2.5" />
        <circle cx="280" cy="98" r="7" fill="#2563eb" stroke="#ffffff" strokeWidth="2.5" />
        <circle cx="240" cy="42" r="6.5" fill="#93c5fd" stroke="#2563eb" strokeWidth="2" strokeDasharray="3 2" />
        <text x="56" y="124" textAnchor="middle" fontSize="11" fontWeight="600" fill="#334155">起点站</text>
        <text x="166" y="124" textAnchor="middle" fontSize="11" fontWeight="700" fill="#1d4ed8">点此起笔拉支线</text>
        <text x="280" y="124" textAnchor="middle" fontSize="11" fontWeight="600" fill="#334155">右键抬笔</text>
        <rect x="248" y="26" width="88" height="22" rx="11" fill="#eff6ff" stroke="#bfdbfe" />
        <text x="292" y="41" textAnchor="middle" fontSize="10.5" fontWeight="600" fill="#1d4ed8">左键继续连站</text>
      </svg>
    );
  }

  if (step === 1) {
    return (
      <svg className="metro-onboard-svg" viewBox="0 0 380 160" aria-hidden="true">
        <rect width="380" height="160" rx="12" fill="#f8fafc" />
        <path d="M 60 118 L 188 34 L 318 118" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="4 4" fill="none" />
        <path
          d="M 60 118 L 130 72 Q 188 34 246 72 L 318 118"
          stroke="#e11d48"
          strokeWidth="5"
          strokeLinecap="round"
          fill="none"
        />
        <line x1="188" y1="34" x2="188" y2="64" stroke="#f59e0b" strokeWidth="2" strokeDasharray="3 3" />
        <circle cx="60" cy="118" r="7" fill="#e11d48" stroke="#ffffff" strokeWidth="2.5" />
        <circle cx="318" cy="118" r="7" fill="#e11d48" stroke="#ffffff" strokeWidth="2.5" />
        <circle cx="188" cy="34" r="6" fill="#ffffff" stroke="#2563eb" strokeWidth="2.2" />
        <circle cx="188" cy="64" r="6.5" fill="#f59e0b" stroke="#ffffff" strokeWidth="2" className="metro-onboard-anim-bob" />
        <rect x="204" y="51" width="136" height="24" rx="12" fill="#fffbeb" stroke="#fde68a" />
        <text x="272" y="67" textAnchor="middle" fontSize="10.5" fontWeight="600" fill="#b45309">右键选调整圆弧 · 拖拉杆</text>
      </svg>
    );
  }

  if (step === 2) {
    return (
      <svg className="metro-onboard-svg" viewBox="0 0 380 160" aria-hidden="true">
        <rect width="380" height="160" rx="12" fill="#f8fafc" />
        <path d="M 52 98 L 190 98 L 328 98" stroke="#0d9488" strokeWidth="5" strokeLinecap="round" fill="none" />
        <circle cx="52" cy="98" r="7" fill="#0d9488" stroke="#ffffff" strokeWidth="2.5" />
        <circle cx="190" cy="98" r="8" fill="#ffffff" stroke="#0d9488" strokeWidth="3" />
        <circle cx="328" cy="98" r="7" fill="#0d9488" stroke="#ffffff" strokeWidth="2.5" />
        <rect x="126" y="42" width="128" height="32" rx="10" fill="#ffffff" stroke="#3b82f6" strokeWidth="1.6" />
        <text x="178" y="62" textAnchor="middle" fontSize="12" fontWeight="600" fill="#0f172a">人民广场</text>
        <rect x="218" y="48" width="28" height="20" rx="6" fill="#eff6ff" />
        <text x="232" y="62" textAnchor="middle" fontSize="10" fontWeight="700" fill="#2563eb">EN</text>
        <text x="190" y="126" textAnchor="middle" fontSize="11" fontWeight="600" fill="#334155">双击线段补站 · 双击站点原地改名</text>
      </svg>
    );
  }

  return (
    <svg className="metro-onboard-svg" viewBox="0 0 380 160" aria-hidden="true">
      <rect width="380" height="160" rx="12" fill="#f8fafc" />
      <rect
        x="76"
        y="30"
        width="180"
        height="96"
        rx="8"
        fill="rgba(37, 99, 235, 0.08)"
        stroke="#3b82f6"
        strokeWidth="1.5"
        strokeDasharray="5 4"
      />
      <path d="M 100 80 L 166 56 L 230 88" stroke="#7c3aed" strokeWidth="4.5" strokeLinecap="round" fill="none" />
      <circle cx="100" cy="80" r="7" fill="#7c3aed" stroke="#ffffff" strokeWidth="2" />
      <circle cx="100" cy="80" r="11" fill="none" stroke="#3b82f6" strokeWidth="1.8" />
      <circle cx="166" cy="56" r="7" fill="#7c3aed" stroke="#ffffff" strokeWidth="2" />
      <circle cx="166" cy="56" r="11" fill="none" stroke="#3b82f6" strokeWidth="1.8" />
      <circle cx="230" cy="88" r="7" fill="#7c3aed" stroke="#ffffff" strokeWidth="2" />
      <circle cx="230" cy="88" r="11" fill="none" stroke="#3b82f6" strokeWidth="1.8" />
      <rect x="270" y="48" width="88" height="26" rx="8" fill="#ffffff" stroke="#cbd5e1" />
      <text x="314" y="65" textAnchor="middle" fontSize="11" fontWeight="700" fill="#334155">Space 抓手</text>
      <rect x="270" y="84" width="88" height="26" rx="8" fill="#ffffff" stroke="#cbd5e1" />
      <text x="314" y="101" textAnchor="middle" fontSize="11" fontWeight="700" fill="#334155">Ctrl+F 搜站</text>
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
            'Select a line on the left, switch to Draw (D), and click blank canvas to place & connect stations.',
            'Hold Shift + Click (or toggle "Bend") while drawing to place multiple 360° free waypoints.',
            'Right-click or press Esc to lift the pen — then click ANY station to extend the other end or pull a branch.'
          ]
        },
        {
          badge: '2 / 4 · 360° Curves & Arcs',
          title: 'Drag any track to bend, right-click bend to adjust arc',
          points: [
            'In Select (V) mode, drag anywhere on a line segment to pull out a 360° waypoint in exact segment order.',
            'Right-click a waypoint and choose "Adjust Arc" to drag its inner radius handle or switch to 3-Point Arc.'
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
            '先在左侧选择一条线路，切至「绘制 (D)」后点空白处直接落站并自动顺延连线。',
            '连笔途中按住 Shift + 左键（或切至顶部「打拐点」），可自由连续点出任意多个 360° 途经点。',
            '右键单击或按 Esc 即可「抬笔」收起虚线，再点任意站点就能从另一端延伸、拉支线或闭合环线。'
          ]
        },
        {
          badge: '2 / 4 · 360° 自由塑形与圆弧调节',
          title: '拖线段任意处生出拐点，右键拐点开启圆弧调节',
          points: [
            '在「选择 (V)」模式下按住区间任意位置直接拖动即可生出途经点——点哪小段就精准插在哪小段，绝不乱序。',
            '右键途经点选择「调整圆弧」，即可拖动橙色拉杆自由设弯道半径，或切换为「过点正圆弧」。'
          ]
        },
        {
          badge: '3 / 4 · 双击快改与换乘合并',
          title: '双击改名、双击线段补站、拖站叠放合换乘',
          points: [
            '双击站点：原地呼出轻量输入框改名（内置 AI 英文翻译），不打断视线。',
            '双击区间线段：在点击处无损劈开区间插入中间站；双击途经点：一键删除恢复直线。',
            '将站点拖到另一条线的站点圆心上松手，可直接合并为换乘枢纽。'
          ]
        },
        {
          badge: '4 / 4 · 框选群移与全局效率手势',
          title: '拉框整片平移 · 空格随时抓手 · Ctrl+F 搜站',
          points: [
            '在「选择 (V)」模式空白处拖拽可拉框多选，拖动任一选中站即可连同内部途经点整片平移。',
            '任意模式下按住「空格键」左键拖（或鼠标中键拖）随时平移画布；按 Ctrl+F 快速搜站定位。'
          ]
        }
      ];

  const shortcutGroups = isCompact
    ? [
        {
          title: isEn ? 'Touch Navigation' : '触屏视图与选择',
          items: [
            { k: isEn ? '2 Fingers' : '双指捏合 / 拖动', d: isEn ? 'Zoom & pan canvas' : '任意模式下缩放与平移画布' },
            { k: isEn ? 'Tap Station' : '点按 / 长按站点', d: isEn ? 'Open station menu' : '唤出改名、方位与起笔菜单' },
            { k: isEn ? 'Drag Track' : '选择态拖线段', d: isEn ? 'Pull out 360° bend' : '在所按位置拉出 360° 途经点' },
            { k: isEn ? 'Long-Press Bend' : '长按途经点', d: isEn ? 'Open arc editor' : '打开圆弧半径与过点弧调节' }
          ]
        },
        {
          title: isEn ? 'Continuous Drawing' : '连续绘制模式',
          items: [
            { k: isEn ? 'Tap Blank' : '点空白处', d: isEn ? 'Add station & connect' : '连续落站并自动顺延连线' },
            { k: isEn ? 'Tap Station' : '点已有站点', d: isEn ? 'Extend / transfer / loop' : '从该站起笔、换乘接入或闭环' },
            { k: isEn ? 'Lift Pen' : '点「抬笔」按钮', d: isEn ? 'Switch ends or branch' : '断链后换另一端延伸或拉支线' }
          ]
        }
      ]
    : [
        {
          title: isEn ? 'Drawing & Shaping' : '连续绘制与圆弧塑形',
          items: [
            { k: 'V / D / H', d: isEn ? 'Select / Draw / Pan mode' : '切换「选择 / 绘制 / 移动」模式' },
            { k: isEn ? 'Draw · Click' : '绘制态 · 左键', d: isEn ? 'Add station / transfer / T-split' : '落新站 · 点已有站换乘 · 点线插站' },
            { k: 'Shift + 左键', d: isEn ? 'Add 360° bends while drawing' : '连笔途中连续打 360° 自由拐点' },
            { k: isEn ? 'Right Click / Esc' : '绘制态 · 右键 / Esc', d: isEn ? 'Lift pen to branch or switch end' : '抬笔断链，换另一端或拉出支线' },
            { k: isEn ? 'Drag Track' : '选择态 · 拖线段', d: isEn ? 'Pull out 360° waypoint' : '在所抓位置拉出途经点，右键调圆弧' },
            { k: 'Alt (按住)', d: isEn ? 'Bypass snap & merge' : '临时关闭角度吸附与叠放合站' }
          ]
        },
        {
          title: isEn ? 'Fast Edits & Navigation' : '快改、多选与全局导航',
          items: [
            { k: isEn ? 'Double Click' : '双击站点 / 线段 / 拐点', d: isEn ? 'Rename / insert / delete bend' : '原地改名 · 劈线补站 · 删拐点拉直' },
            { k: isEn ? 'Blank Drag' : '选择态 · 空白拖拽', d: isEn ? 'Box-select & group move' : '矩形框选多站并整片同步平移' },
            { k: 'Space + 拖拽', d: isEn ? 'Temporary hand pan' : '任意模式下临时抓手平移画布' },
            { k: 'Ctrl + F', d: isEn ? 'Find & center station' : '搜索站名或线路并平滑居中定位' },
            { k: 'Delete / Backspace', d: isEn ? 'Delete selected items' : '批量删除选中站点（自动缝合）' },
            { k: 'Ctrl + Z / Y', d: isEn ? 'Undo / Redo' : '撤销上一步操作 / 重做修改' }
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
            <ElasticCapsuleTabs<'tour' | 'cheatsheet'>
              size="md"
              ariaLabel={isEn ? 'Guide mode' : '指南视图切换'}
              value={view}
              onChange={setView}
              options={[
                { value: 'tour', label: isEn ? 'Interactive Guide' : '4 步上手演示' },
                { value: 'cheatsheet', label: isEn ? 'Gestures & Shortcuts' : '全部手势与快捷键' }
              ]}
            />
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
                    <div className="metro-onboard__rows">
                      {group.items.map((item) => (
                        <div key={item.k} className="metro-onboard__row">
                          <kbd className="metro-onboard__kbd">{item.k}</kbd>
                          <span className="metro-onboard__desc">{item.d}</span>
                        </div>
                      ))}
                    </div>
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
