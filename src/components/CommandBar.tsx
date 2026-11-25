import React, { useEffect, useMemo, useState } from 'react';
import {
  CommandCompletionItem,
  CommandContext,
  getCommandCompletions
} from '../lib/commandParser';
import { Line, Station } from '../types';

export interface CommandSubmitResult {
  ok: boolean;
  message: string;
  aiPromptSuggestion?: string;
}

interface CommandBarProps {
  onSubmit: (input: string) => CommandSubmitResult;
  onAskAI?: (prompt: string) => void;
  lines?: Pick<Line, 'id' | 'name' | 'color' | 'stationIds'>[];
  stations?: Pick<Station, 'id' | 'name' | 'x' | 'y'>[];
  currentLineId?: string | null;
  inputRef?: React.RefObject<HTMLInputElement>;
}

const CommandBar: React.FC<CommandBarProps> = ({
  onSubmit,
  onAskAI,
  lines = [],
  stations = [],
  currentLineId = null,
  inputRef
}) => {
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);
  const [feedback, setFeedback] = useState<CommandSubmitResult | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null);

  useEffect(() => {
    if (!feedback) return;
    const duration = feedback.aiPromptSuggestion ? 9000 : 5200;
    const timer = window.setTimeout(() => setFeedback(null), duration);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const ctx = useMemo<CommandContext>(
    () => ({ lines, stations, currentLineId }),
    [lines, stations, currentLineId]
  );

  const suggestions = useMemo<CommandCompletionItem[]>(
    () => (focused && input.length > 0 ? getCommandCompletions(input, ctx) : []),
    [focused, input, ctx]
  );

  const applyCompletion = (item: CommandCompletionItem) => {
    const nextValue = input.slice(0, item.replaceStart) + item.insertText;
    setInput(nextValue);
    inputRef?.current?.focus();
  };

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    const result = onSubmit(text);
    setFeedback(result);
    setHistory((prev) => (prev[prev.length - 1] === text ? prev : [...prev, text]).slice(-50));
    setHistIdx(null);
    if (result.ok) {
      setInput('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setInput('');
      setFeedback(null);
      (e.target as HTMLInputElement).blur();
      return;
    }
    if (e.key === 'Tab' && suggestions.length > 0) {
      e.preventDefault();
      applyCompletion(suggestions[0]);
      return;
    }
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
      if (idx >= history.length) {
        setHistIdx(null);
        setInput('');
      } else {
        setHistIdx(idx);
        setInput(history[idx]);
      }
    }
  };

  const isExpanded = focused || input.length > 0;
  const isAiPrefix = /^(ai\s|\?|？)/i.test(input.trimStart());

  return (
    <div className={`metro-command-bar${isExpanded ? ' is-expanded' : ''}`}>
      {feedback && (
        <div
          className={`metro-command-bar__feedback ${feedback.ok ? 'is-ok' : 'is-error'}`}
          onClick={() => {
            if (!feedback.aiPromptSuggestion) setFeedback(null);
          }}
        >
          <span>{feedback.message}</span>
          {feedback.aiPromptSuggestion && onAskAI && (
            <button
              type="button"
              className="metro-command-bar__ai-btn"
              onClick={(ev) => {
                ev.stopPropagation();
                const prompt = feedback.aiPromptSuggestion!;
                setFeedback(null);
                setInput('');
                onAskAI(prompt);
              }}
            >
              ✨ 交给 AI 执行
            </button>
          )}
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="metro-command-bar__suggest">
          {suggestions.map((s) => (
            <button
              type="button"
              key={`${s.replaceStart}_${s.label}`}
              className="metro-command-bar__chip"
              onMouseDown={(e) => {
                e.preventDefault();
                applyCompletion(s);
              }}
            >
              {s.swatch && (
                <span
                  className="metro-command-bar__chip-swatch"
                  style={{ backgroundColor: s.swatch }}
                />
              )}
              <span>{s.label}</span>
              {s.hint && <span className="metro-command-bar__chip-hint">{s.hint}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="metro-command-bar__row" onClick={() => inputRef?.current?.focus()}>
        <span className="metro-command-bar__prompt">{isAiPrefix ? '✦' : '›'}</span>
        <input
          ref={inputRef}
          className="metro-command-bar__input"
          value={input}
          spellCheck={false}
          autoComplete="off"
          placeholder={
            isExpanded
              ? '如 line 1号线 red 西站 人民广场 东站 · loop 4号线 purple … · ai 智能起名 · help'
              : '输入命令或 ? 唤起 AI…'
          }
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {!isExpanded && (
          <kbd className="metro-command-bar__kbd" aria-hidden="true">
            /
          </kbd>
        )}
      </div>
    </div>
  );
};

export default CommandBar;
