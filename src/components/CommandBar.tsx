import React, { useEffect, useState } from 'react';
import { COMMAND_VERBS } from '../lib/commandParser';

// 左下角灵动命令浮岛：平时紧凑不抢画面，聚焦或按 "/" 时平滑展开完整命令输入与自动补全。
interface CommandBarProps {
  onSubmit: (input: string) => { ok: boolean; message: string };
  inputRef?: React.RefObject<HTMLInputElement>;
}

const CommandBar: React.FC<CommandBarProps> = ({ onSubmit, inputRef }) => {
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 4500);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const firstToken = input.trimStart().split(/\s+/)[0]?.toLowerCase() || '';
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
    if (e.key === 'Escape') { e.preventDefault(); setInput(''); setFeedback(null); (e.target as HTMLInputElement).blur(); return; }
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

  const isExpanded = focused || input.length > 0;

  return (
    <div className={`metro-command-bar${isExpanded ? ' is-expanded' : ''}`}>
      {feedback && (
        <div
          className={`metro-command-bar__feedback ${feedback.ok ? 'is-ok' : 'is-error'}`}
          onClick={() => setFeedback(null)}
        >
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
              onMouseDown={(e) => { e.preventDefault(); setInput(s + ' '); inputRef?.current?.focus(); }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="metro-command-bar__row" onClick={() => inputRef?.current?.focus()}>
        <span className="metro-command-bar__prompt">›</span>
        <input
          ref={inputRef}
          className="metro-command-bar__input"
          value={input}
          spellCheck={false}
          autoComplete="off"
          placeholder={isExpanded ? '输入命令，如 create line "2号线" blue · 输入 help 查看用法' : '输入命令…'}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {!isExpanded && <kbd className="metro-command-bar__kbd" aria-hidden="true">/</kbd>}
      </div>
    </div>
  );
};

export default CommandBar;
