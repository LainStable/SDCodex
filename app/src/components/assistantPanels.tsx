/* Settings → System panels: the assistant endpoint (which turns the topbar
   search into a chat bar) and the MCP server external agents connect to. */

import { useEffect, useState } from 'react';
import { GhostButton, PrimaryButton } from './chrome';
import {
  getAssistantStatus,
  getMcpSettings,
  saveAssistantSettings,
  saveMcpSettings,
  testAssistant,
  type AssistantStatus,
  type McpSettings,
} from '../lib/assistant';

const fieldClass =
  'mt-1 w-full rounded border border-white/10 bg-obsidian-lowest px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-primary focus:ring-2 focus:ring-primary/25';

function useCopy() {
  const [copied, setCopied] = useState('');
  const copy = (label: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(label),
      () => setCopied(''),
    );
  };
  return { copied, copy };
}

export function AssistantPanel({ isAdmin }: { isAdmin: boolean }) {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    void getAssistantStatus()
      .then((next) => {
        if (!live) return;
        setStatus(next);
        setBaseUrl(next.baseUrl);
        setModel(next.model);
      })
      .catch((error: unknown) => {
        if (live) setMessage(error instanceof Error ? error.message : 'Unable to load assistant settings.');
      });
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    setBusy(true);
    setMessage('');
    try {
      const next = await saveAssistantSettings({
        baseUrl,
        model,
        ...(apiKey.trim() ? { apiKey } : {}),
      });
      setStatus(next);
      setApiKey('');
      setMessage(
        next.configured
          ? 'Saved. The topbar search box is now the assistant chat bar.'
          : 'Saved. Set both an endpoint and a model to enable the chat bar.',
      );
      window.dispatchEvent(new Event('sdcodex:assistant-changed'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to save.');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMessage('Testing…');
    try {
      const result = await testAssistant({
        baseUrl,
        model,
        ...(apiKey.trim() ? { apiKey } : {}),
      });
      if (result.ok) {
        const found = (result.models ?? []).filter(Boolean);
        setModels(found);
        setMessage(
          `Reachable in ${result.latencyMs ?? 0} ms — ${found.length} model(s) below. Click one to use it.`,
        );
      } else {
        setModels([]);
        setMessage(result.error ?? 'The endpoint did not answer.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The test failed.');
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    setMessage('');
    try {
      setStatus(await saveAssistantSettings({ clearApiKey: true }));
      setMessage('API key cleared.');
      window.dispatchEvent(new Event('sdcodex:assistant-changed'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to clear the key.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-white/[0.06] bg-obsidian-lowest/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-display text-sm font-semibold">AI assistant</h3>
          <p className="mt-1 font-mono text-[11px] text-ink-faint">
            Any OpenAI-compatible endpoint (OpenAI, LM Studio, Ollama, vLLM). Once set, the topbar
            search box becomes a chat bar that can search Civitai, read plugin/task state, and run
            plugin tasks after you confirm them.
          </p>
        </div>
        <span
          className={`font-mono text-[10px] uppercase ${
            status?.configured ? 'text-status-active' : 'text-ink-faint'
          }`}
        >
          {status?.configured ? 'active' : 'not configured'}
        </span>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
            Base URL
          </span>
          <input
            value={baseUrl}
            disabled={!isAdmin}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="http://127.0.0.1:1234/v1"
            className={fieldClass}
          />
        </label>
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
            Model
          </span>
          <input
            value={model}
            disabled={!isAdmin}
            onChange={(event) => setModel(event.target.value)}
            placeholder="qwen2.5-7b-instruct"
            className={fieldClass}
          />
        </label>
        <label className="block md:col-span-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
            API key {status?.apiKeySet && <span className="text-status-active">(saved)</span>}
          </span>
          <input
            type="password"
            value={apiKey}
            disabled={!isAdmin}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={status?.apiKeySet ? '•••••••• (leave blank to keep)' : 'optional'}
            className={fieldClass}
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <PrimaryButton disabled={!isAdmin || busy} onClick={() => void save()}>
          Save
        </PrimaryButton>
        <GhostButton disabled={!isAdmin || busy} onClick={() => void test()}>
          Test connection
        </GhostButton>
        {status?.apiKeySet && (
          <GhostButton disabled={!isAdmin || busy} onClick={() => void clearKey()}>
            Clear key
          </GhostButton>
        )}
        {!isAdmin && (
          <span className="font-mono text-[11px] text-ink-faint">
            Administrators configure the assistant endpoint.
          </span>
        )}
      </div>
      {message && (
        <p role="status" className="mt-2 font-mono text-[11px] text-ink-muted">
          {message}
        </p>
      )}
      {models.length > 0 && (
        <div className="mt-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
            Available models ({models.length}) — click to use
          </p>
          <ul className="mt-1 max-h-40 overflow-y-auto rounded border border-white/10 bg-black/20 p-1">
            {models.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  disabled={!isAdmin}
                  onClick={() => setModel(name)}
                  title={name === model ? 'Already selected' : `Use ${name}`}
                  className={`block w-full truncate rounded px-2 py-1 text-left font-mono text-[11px] ${
                    name === model
                      ? 'bg-primary/20 text-white'
                      : 'text-ink-muted hover:bg-white/5 hover:text-ink'
                  }`}
                >
                  {name === model ? `✓ ${name}` : name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function McpPanel({ isAdmin }: { isAdmin: boolean }) {
  const [settings, setSettings] = useState<McpSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reveal, setReveal] = useState(false);
  const { copied, copy } = useCopy();

  useEffect(() => {
    let live = true;
    void getMcpSettings()
      .then((next) => {
        if (live) setSettings(next);
      })
      .catch((error: unknown) => {
        if (live) setMessage(error instanceof Error ? error.message : 'Unable to load MCP settings.');
      });
    return () => {
      live = false;
    };
  }, []);

  const update = async (payload: { enabled?: boolean; rotateToken?: boolean }) => {
    setBusy(true);
    setMessage('');
    try {
      setSettings(await saveMcpSettings(payload));
      setMessage(payload.rotateToken ? 'New token generated — update your clients.' : 'Saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to save MCP settings.');
    } finally {
      setBusy(false);
    }
  };

  const endpoint = `${window.location.origin}${settings?.path ?? '/api/mcp'}`;
  const token = settings?.token ?? '';
  const snippet = JSON.stringify(
    {
      mcpServers: {
        sdcodex: {
          type: 'http',
          url: endpoint,
          headers: { Authorization: `Bearer ${token || '<token>'}` },
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="mt-3 rounded-lg border border-white/[0.06] bg-obsidian-lowest/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-display text-sm font-semibold">MCP server</h3>
          <p className="mt-1 font-mono text-[11px] text-ink-faint">
            Exposes the same tool registry as the assistant — Civitai search plus the actions each
            installed plugin declares — so an external agent can do what the UI does. Calls run
            immediately (the client owns confirmation), so treat the token like a password.
          </p>
        </div>
        <span
          className={`font-mono text-[10px] uppercase ${
            settings?.enabled ? 'text-status-active' : 'text-ink-faint'
          }`}
        >
          {settings?.enabled ? 'listening' : 'off'}
        </span>
      </div>

      <div className="mt-3 rounded border border-white/[0.06] bg-black/20 p-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
            Endpoint
          </span>
          <code className="truncate font-mono text-[11px] text-ink">{endpoint}</code>
          <GhostButton className="ml-auto" onClick={() => copy('endpoint', endpoint)}>
            {copied === 'endpoint' ? 'Copied' : 'Copy'}
          </GhostButton>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
            Token
          </span>
          <code className="truncate font-mono text-[11px] text-ink-muted">
            {token ? (reveal ? token : `${token.slice(0, 6)}…${token.slice(-4)}`) : 'not generated yet'}
          </code>
          {token && (
            <GhostButton onClick={() => setReveal((value) => !value)}>
              {reveal ? 'Hide' : 'Reveal'}
            </GhostButton>
          )}
          {token && (
            <GhostButton onClick={() => copy('token', token)}>
              {copied === 'token' ? 'Copied' : 'Copy'}
            </GhostButton>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!isAdmin || busy || !settings}
          aria-pressed={Boolean(settings?.enabled)}
          onClick={() => void update({ enabled: !settings?.enabled })}
          className={`rounded border px-3 py-1.5 font-mono text-[11px] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            settings?.enabled
              ? 'border-status-active/50 bg-status-active/10 text-status-active'
              : 'border-white/10 bg-white/[0.03] text-ink-muted hover:border-white/20 hover:text-ink'
          }`}
        >
          {settings?.enabled ? 'Enabled' : 'Disabled'}
        </button>
        <GhostButton disabled={!isAdmin || busy || !settings} onClick={() => void update({ rotateToken: true })}>
          Rotate token
        </GhostButton>
        {settings?.token && (
          <GhostButton onClick={() => copy('config', snippet)}>
            {copied === 'config' ? 'Copied' : 'Copy client config'}
          </GhostButton>
        )}
        {!isAdmin && (
          <span className="font-mono text-[11px] text-ink-faint">
            Administrators control the MCP server.
          </span>
        )}
      </div>

      {settings?.token && (
        <pre className="mt-3 max-h-48 overflow-auto rounded bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-ink-muted">
          {snippet}
        </pre>
      )}
      {message && (
        <p role="status" className="mt-2 font-mono text-[11px] text-ink-muted">
          {message}
        </p>
      )}
    </div>
  );
}
