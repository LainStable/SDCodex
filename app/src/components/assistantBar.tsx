/* Topbar assistant bar: replaces the plain search field once an assistant
   endpoint is configured (Settings → System). The backend holds the endpoint,
   runs the model, and calls tools.

   The conversation itself lives in a floating task-style card (bottom right,
   like the download / plugin-task notifications) so long model replies stay
   readable: confirmations gate plugin tasks, and a follow-up box lets you
   answer the model's questions or steer the task. The topbar stays a
   single-line entry point. */

import { useEffect, useRef, useState } from 'react';
import { GhostButton, PrimaryButton } from './chrome';
import {
  assistantChat,
  type AssistantAction,
  type AssistantMessage,
  type AssistantPending,
} from '../lib/assistant';

type Turn = { role: 'user' | 'assistant'; text: string; tools?: string[] };

export function AssistantBar({
  onAction,
  model,
}: {
  onAction: (action: AssistantAction) => void;
  model?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [follow, setFollow] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState<AssistantPending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
      followRef.current?.focus();
    }
  }, [open, turns, busy, pending, error]);

  const send = async (text: string, approved?: { name: string; args: Record<string, unknown> }) => {
    const question = text.trim();
    if (!question && !approved) return;
    setOpen(true);
    setError('');
    const base: Turn[] = approved
      ? [...turns, { role: 'user', text: `Run: ${pending?.description ?? approved.name}` }]
      : [...turns, { role: 'user', text: question }];
    setTurns(base);
    setPending(null);
    setBusy(true);
    try {
      const messages: AssistantMessage[] = base.map((turn) => ({
        role: turn.role,
        content: turn.text,
      }));
      const result = await assistantChat(messages, approved);
      setTurns([
        ...base,
        {
          role: 'assistant',
          text:
            result.reply?.trim() ||
            (result.pending
              ? 'This task changes files on disk — confirm it below and I will run it.'
              : 'Done.'),
          tools: result.toolsUsed ?? [],
        },
      ]);
      if (result.pending) setPending(result.pending);
      for (const action of result.actions ?? []) onAction(action);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The assistant call failed.');
    } finally {
      setBusy(false);
    }
  };

  const submitFollow = () => {
    if (busy || !follow.trim()) return;
    const text = follow;
    setFollow('');
    void send(text);
  };

  const hasPanel = busy || Boolean(error) || Boolean(pending) || turns.length > 0;

  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <button
          type="button"
          onClick={() => (hasPanel ? setOpen((o) => !o) : null)}
          title={hasPanel ? 'Toggle assistant conversation' : 'Assistant ready — type below'}
          aria-label="Toggle assistant conversation"
          className="shrink-0 text-primary"
        >
          ✦
        </button>
        <input
          data-search
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (busy || !draft.trim()) return;
              const question = draft;
              setDraft('');
              void send(question);
            }
          }}
          placeholder="Ask the assistant — search Civitai, check a plugin task…  ( / )"
          className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
        />
        {busy ? (
          <span className="shrink-0 font-mono text-[10px] text-ink-faint">thinking…</span>
        ) : (
          <kbd className="shrink-0 rounded border border-white/10 bg-white/5 px-1.5 font-mono text-[10px] text-ink-faint">
            ⏎
          </kbd>
        )}
      </div>

      {open && hasPanel && (
        <div className="glass-l2 fixed bottom-3 right-3 z-[56] flex max-h-[72vh] w-[min(430px,94vw)] flex-col overflow-hidden rounded-lg">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
            <span className="text-primary" aria-hidden>
              ✦
            </span>
            <span className="font-display text-sm font-semibold text-ink">Assistant</span>
            {model && <span className="truncate font-mono text-[10px] text-ink-faint">{model}</span>}
            {busy && <span className="font-mono text-[10px] text-ink-faint">thinking…</span>}
            <div className="ml-auto flex items-center gap-2">
              {turns.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setTurns([]);
                    setPending(null);
                    setError('');
                  }}
                  className="font-mono text-[10px] text-ink-faint hover:text-white"
                >
                  clear
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Minimize assistant"
                title="Minimize (reopens on new activity)"
                className="text-ink-faint hover:text-white"
              >
                ✕
              </button>
            </div>
          </div>

          <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {turns.map((turn, index) => (
              <div key={index} className="space-y-1">
                <div className={`flex ${turn.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <p
                    className={`max-w-[90%] whitespace-pre-wrap rounded px-2.5 py-1.5 text-xs leading-relaxed ${
                      turn.role === 'user'
                        ? 'border border-primary/30 bg-primary/10 text-ink'
                        : 'border border-white/[0.06] bg-obsidian-lowest/70 text-ink-muted'
                    }`}
                  >
                    {turn.text}
                  </p>
                </div>
                {turn.tools && turn.tools.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {turn.tools.map((tool, i) => (
                      <span
                        key={i}
                        className="rounded-[3px] border border-white/10 bg-white/[0.03] px-2 py-0.5 font-mono text-[10px] text-ink-faint"
                      >
                        {tool.replace(/^plugin__/, '').replace(/__/g, ' · ')}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {pending && (
              <div className="rounded border border-status-warning/40 bg-status-warning/10 p-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-status-warning">
                  Needs confirmation
                </p>
                <p className="mt-1 text-xs text-ink">{pending.message}</p>
                {pending.params && Object.keys(pending.params).length > 0 && (
                  <pre className="mt-1 overflow-x-auto rounded bg-black/30 p-1.5 font-mono text-[10px] text-ink-muted">
                    {JSON.stringify(pending.params, null, 2)}
                  </pre>
                )}
                <div className="mt-2 flex gap-2">
                  <PrimaryButton
                    disabled={busy}
                    className="!px-3 !py-1 !text-xs"
                    onClick={() => void send('', { name: pending.tool, args: pending.args })}
                  >
                    Run task
                  </PrimaryButton>
                  <GhostButton disabled={busy} onClick={() => setPending(null)}>
                    Cancel
                  </GhostButton>
                </div>
              </div>
            )}

            {error && (
              <p role="alert" className="font-mono text-[11px] text-[#f87171]">
                {error}
              </p>
            )}
            {busy && (
              <p className="font-mono text-[11px] text-ink-faint">
                Working — the model may call tools before answering…
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-white/[0.06] p-2">
            <input
              ref={followRef}
              value={follow}
              onChange={(event) => setFollow(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submitFollow();
                }
              }}
              placeholder={pending ? 'Answer, adjust, or cancel above…' : 'Reply, answer, or steer the task…'}
              aria-label="Reply to the assistant"
              className="w-full rounded border border-white/10 bg-obsidian-lowest px-2.5 py-1.5 text-xs outline-none placeholder:text-ink-faint focus:border-primary"
            />
            <PrimaryButton
              disabled={busy || !follow.trim()}
              className="!px-3 !py-1.5 !text-xs"
              onClick={submitFollow}
            >
              Send
            </PrimaryButton>
          </div>
        </div>
      )}
    </>
  );
}
