/* Assistant client. The in-app chat bar and the MCP settings panel both talk to
   /api/assistant/* and /api/mcp/*; the backend keeps the endpoint + key. */

import { apiGet, apiPost } from './backend';

export type AssistantStatus = {
  baseUrl: string;
  model: string;
  apiKeySet: boolean;
  configured: boolean;
  isAdmin?: boolean;
};

export type AssistantSearchParams = {
  q: string;
  type?: string;
  baseModels?: string[];
  sort?: string;
  nsfw?: boolean;
};

export type AssistantAction = { type: 'search'; params: AssistantSearchParams };

export type AssistantPending = {
  tool: string;
  args: Record<string, unknown>;
  pluginId?: string;
  action?: string;
  params?: Record<string, string>;
  description: string;
  message: string;
};

export type AssistantMessage = { role: 'user' | 'assistant'; content: string };

export type AssistantReply = {
  ok: boolean;
  reply?: string;
  actions?: AssistantAction[];
  pending?: AssistantPending;
  toolsUsed?: string[];
};

export type McpSettings = {
  enabled: boolean;
  token: string;
  path: string;
  isAdmin?: boolean;
};

export type AssistantTestResult = {
  ok: boolean;
  models?: string[];
  latencyMs?: number;
  model?: string;
  error?: string;
};

export const getAssistantStatus = () => apiGet<AssistantStatus>('/assistant/status');

export const assistantChat = (
  messages: AssistantMessage[],
  approved?: { name: string; args: Record<string, unknown> },
) =>
  apiPost<AssistantReply>(
    '/assistant/chat',
    approved ? { messages, approved } : { messages },
  );

export const saveAssistantSettings = (payload: {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  clearApiKey?: boolean;
}) => apiPost<AssistantStatus>('/assistant/settings', payload);

export const testAssistant = (payload?: {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}) => apiPost<AssistantTestResult>('/assistant/test', payload ?? {});

export const getMcpSettings = () => apiGet<McpSettings>('/mcp/settings');

export const saveMcpSettings = (payload: { enabled?: boolean; rotateToken?: boolean }) =>
  apiPost<McpSettings>('/mcp/settings', payload);
