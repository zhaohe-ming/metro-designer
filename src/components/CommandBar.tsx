import React, { useState } from 'react';
import { COMMAND_VERBS } from '../lib/commandParser';

// AutoCAD 式底部命令栏（v1）。纯受控输入：Enter 执行、↑/↓ 历史、Esc 失焦、Tab 补全动词。
// 解析/执行都在 App（onSubmit），本组件只管输入与展示。焦点冲突由 App 的全局 keydown
// 已处理（INPUT 聚焦时不触发画布 Ctrl+Z）。
interface CommandBarProps {
  onSubmit: (input: string) => { ok: boolean; message: string };
  inputRef?: React.RefObject<HTMLInputElement>;
}

const CommandBar: React.FC<CommandBarProps> = ({ onSubmit, inputRef }) => {
  const [input, setInput] = useState('');
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null);

  const firstToken = input.trimStart().split(/\s+/)[0]?.toLowerCase() || '';
  // 仅在输入首词、且还没打空格时提示候选动词
  const suggestions =
    input.length > 0 && !input.includes(' ') && firstToken.length > 0
      ? COMMAND_VERBS.filter(v => v.startsWith(firstToken) && v !== firstToken).slice(0, 8)
      : [];

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    const result = onSubmit(text);
    setFeedback(result);
    setHistory(prev => (prev[prev.length - 1] === text ? prev : [...prev, text]).slice(-50));
    setHistIdx(null);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); return; }
    if (e.key === 'Escape') { e.preventDefault(); setInput(''); (e.target as HTMLInputElement).blur(); return; }
    if (e.key === 'Tab' && suggestions.length > 0) { e.preventDefault(); setInput(suggestions[0] + ' '); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const idx = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      setInput(history[idx]);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx === null) return;
      const idx = histIdx + 1;
      if (idx >= history.length) { setHistIdx(null); setInput(''); }
      else { setHistIdx(idx); setInput(history[idx]); }
    }
  };

  return (
    <div className="metro-command-bar">
      {feedback && (
        <div className={`metro-command-bar__feedback ${feedback.ok ? 'is-ok' : 'is-error'}`}>
          {feedback.message}
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="metro-command-bar__suggest">
          {suggestions.map(s => (
            <button
              type="button"
              key={s}
              className="metro-command-bar__chip"
              // mousedown preventDefault：点 chip 时不要先 blur 输入框
              onMouseDown={(e) => { e.preventDefault(); setInput(s + ' '); inputRef?.current?.focus(); }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="metro-command-bar__row">
        <span className="metro-command-bar__prompt">›</span>
        <input
          ref={inputRef}
          className="metro-command-bar__input"
          value={input}
          spellCheck={false}
          autoComplete="off"
          placeholder={'输入命令，如  create line "2号线" blue  ；输入 help 查看用法（/ 聚焦）'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
    </div>
  );
};

export default CommandBar;
