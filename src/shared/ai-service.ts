import { AIProvider } from './types';
import { tauriFetch, httpProbe } from './http';

export interface AIServiceConfig {
  provider: AIProvider;
  omlxServerUrl: string;
  omlxModel: string;
  omlxApiKey: string;
  ollamaServerUrl: string;
  ollamaModel: string;
  openaiApiKey: string;
  openaiModel: string;
  customApiEndpoint: string;
  customModel: string;
  customApiKey: string;
}

export type TokenHandler = (delta: string) => void;

/** Body/parse style for chat endpoints. */
type ChatFormat = 'ollama' | 'openai';

export async function generateText(
  systemPrompt: string,
  userContent: string,
  config: AIServiceConfig
): Promise<string> {
  let full = '';
  await generateTextStream(systemPrompt, userContent, config, (delta) => {
    full += delta;
  });
  return full.trim();
}

/**
 * Streaming variant: invokes `onToken` for each text delta and resolves with the
 * full text. Powers the live "typing" result in the command palette.
 *
 * Note: `local-cli` is handled in the Tauri bridge (it spawns a process), so
 * this service only covers the HTTP providers (`omlx`, `ollama`, `openai`,
 * `custom`).
 */
export async function generateTextStream(
  systemPrompt: string,
  userContent: string,
  config: AIServiceConfig,
  onToken: TokenHandler
): Promise<string> {
  switch (config.provider) {
    case 'custom':
      return streamCustom(systemPrompt, userContent, config, onToken);
    case 'ollama':
      return streamOllama(systemPrompt, userContent, config, onToken);
    case 'openai':
      return streamOpenAi(systemPrompt, userContent, config, onToken);
    case 'omlx':
    default:
      return streamOmlx(systemPrompt, userContent, config, onToken);
  }
}

/** Base URL for the hosted OpenAI API (OpenAI-compatible, /v1/...). */
export const OPENAI_BASE_URL = 'https://api.openai.com';

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Best-effort human-readable detail from a thrown value. */
function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message || err.toString();
  if (typeof err === 'string') return err;
  try {
    const s = JSON.stringify(err);
    if (s && s !== '{}') return s;
  } catch {
    // fall through
  }
  return String(err);
}

/** Include the response body (truncated) so failures are debuggable. */
async function responseDetail(res: Response): Promise<string> {
  const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  try {
    const text = (await res.text()).trim();
    return text ? `${status}: ${text.slice(0, 400)}` : status;
  } catch {
    return status;
  }
}

/**
 * Issue a connection-check request via the Rust `http_probe` command (which
 * surfaces the real transport-error cause) and parse the JSON body. Throws with
 * `HTTP <status>: <body>` on a non-2xx response, and propagates the detailed
 * network-error string on transport failure.
 */
async function probeJson(
  url: string,
  options?: { method?: 'GET' | 'POST' | 'PUT'; apiKey?: string; body?: string }
): Promise<any> {
  const { status, body } = await httpProbe(url, options);
  if (status < 200 || status >= 300) {
    const detail = body.trim().slice(0, 400);
    throw new Error(`HTTP ${status}${detail ? `: ${detail}` : ''}`);
  }
  if (!body.trim()) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Infer the chat wire format from an endpoint URL path. */
function formatForEndpoint(endpoint: string): ChatFormat {
  return /\/api\/chat\b/.test(endpoint) ? 'ollama' : 'openai';
}

/**
 * Read a streaming Response line-by-line, handing each non-empty line to
 * `parseLine`. Returns the accumulated text. Works for both NDJSON (Ollama)
 * and SSE `data:` lines (OpenAI-compatible).
 */
async function consumeStream(
  response: Response,
  parseLine: (line: string) => string | null,
  onToken: TokenHandler
): Promise<string> {
  const body = response.body;
  if (!body) {
    throw new Error('No response body to stream');
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  const flushLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const delta = parseLine(trimmed);
    if (delta) {
      full += delta;
      onToken(delta);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      flushLine(line);
    }
  }

  // Flush any trailing partial line.
  flushLine(buffer);
  return full;
}

function parseOllamaLine(line: string): string | null {
  try {
    const json = JSON.parse(line);
    return json?.message?.content ?? null;
  } catch {
    return null;
  }
}

function parseOpenAiLine(line: string): string | null {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    const json = JSON.parse(payload);
    return json?.choices?.[0]?.delta?.content ?? null;
  } catch {
    return null;
  }
}

async function fetchOllamaModels(serverUrl: string): Promise<string[]> {
  const base = trimTrailingSlash(serverUrl);
  const data = await probeJson(`${base}/api/tags`);
  const models = Array.isArray(data?.models) ? data.models : [];
  return models.map((m: any) => m?.name).filter((n: any): n is string => !!n);
}

async function resolveOllamaModel(config: AIServiceConfig): Promise<string> {
  if (config.ollamaModel.trim()) return config.ollamaModel.trim();
  const models = await fetchOllamaModels(config.ollamaServerUrl);
  if (!models.length) {
    throw new Error('No Ollama models installed. Run `ollama pull <model>` first.');
  }
  return models[0];
}

async function streamOllama(
  systemPrompt: string,
  userContent: string,
  config: AIServiceConfig,
  onToken: TokenHandler
): Promise<string> {
  if (!config.ollamaServerUrl.trim()) {
    throw new Error('Ollama server URL not configured. Set it in Settings.');
  }

  const model = await resolveOllamaModel(config);
  const base = trimTrailingSlash(config.ollamaServerUrl);

  const res = await tauriFetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      stream: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama request failed — ${await responseDetail(res)}`);
  }

  const full = await consumeStream(res, parseOllamaLine, onToken);
  if (!full.trim()) {
    throw new Error('No response from Ollama');
  }
  return full.trim();
}

async function streamCustom(
  systemPrompt: string,
  userContent: string,
  config: AIServiceConfig,
  onToken: TokenHandler
): Promise<string> {
  if (!config.customApiEndpoint.trim()) {
    throw new Error('Custom API endpoint not configured. Set it in Settings.');
  }
  if (!config.customModel.trim()) {
    throw new Error('Custom model name not configured. Set it in Settings.');
  }

  const endpoint = config.customApiEndpoint.trim();
  const format = formatForEndpoint(endpoint);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.customApiKey.trim()) {
    headers.Authorization = `Bearer ${config.customApiKey.trim()}`;
  }

  const body = JSON.stringify({
    model: config.customModel.trim(),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    stream: true,
  });

  const res = await tauriFetch(endpoint, { method: 'POST', headers, body });
  if (!res.ok) {
    throw new Error(`Custom endpoint request failed — ${await responseDetail(res)}`);
  }

  const parser = format === 'ollama' ? parseOllamaLine : parseOpenAiLine;
  const full = await consumeStream(res, parser, onToken);
  if (!full.trim()) {
    throw new Error('No response from custom endpoint');
  }
  return full.trim();
}

/** Bearer auth headers for oMLX requests (the API key is optional). */
function omlxHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
  return headers;
}

/** List models from an oMLX (OpenAI-compatible) server via GET /v1/models. */
async function fetchOmlxModels(serverUrl: string, apiKey: string): Promise<string[]> {
  const base = trimTrailingSlash(serverUrl);
  const data = await probeJson(`${base}/v1/models`, { apiKey });
  const models = Array.isArray(data?.data) ? data.data : [];
  return models.map((m: any) => m?.id).filter((id: any): id is string => !!id);
}

async function resolveOmlxModel(config: AIServiceConfig): Promise<string> {
  if (config.omlxModel.trim()) return config.omlxModel.trim();
  const models = await fetchOmlxModels(config.omlxServerUrl, config.omlxApiKey);
  if (!models.length) {
    throw new Error('No oMLX models available. Load a model in the oMLX admin panel first.');
  }
  return models[0];
}

async function streamOmlx(
  systemPrompt: string,
  userContent: string,
  config: AIServiceConfig,
  onToken: TokenHandler
): Promise<string> {
  if (!config.omlxServerUrl.trim()) {
    throw new Error('oMLX server URL not configured. Set it in Settings.');
  }

  const model = await resolveOmlxModel(config);
  const base = trimTrailingSlash(config.omlxServerUrl);

  const res = await tauriFetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: omlxHeaders(config.omlxApiKey),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      stream: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`oMLX request failed — ${await responseDetail(res)}`);
  }

  const full = await consumeStream(res, parseOpenAiLine, onToken);
  if (!full.trim()) {
    throw new Error('No response from oMLX');
  }
  return full.trim();
}

// ---------- OpenAI (hosted api.openai.com) ----------

/** Bearer auth headers for OpenAI requests (the API key is required). */
function openAiHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey.trim()}`,
  };
}

/**
 * Substrings that mark a model as NOT a text-chat model (audio, vision-only,
 * embeddings, image, moderation, etc.). These are excluded from selection.
 */
const OPENAI_NON_CHAT_MARKERS = [
  'embedding',
  'whisper',
  'tts',
  'audio',
  'realtime',
  'transcribe',
  'image',
  'dall-e',
  'moderation',
  'search',
  'codex',
];

function isOpenAiChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (OPENAI_NON_CHAT_MARKERS.some((m) => lower.includes(m))) return false;
  // Chat-capable families: gpt-*, and reasoning models (o1/o3/o4...).
  return lower.startsWith('gpt') || /^o\d/.test(lower) || lower.startsWith('chatgpt');
}

/**
 * Rough latency rank for an OpenAI model — lower is faster to respond. The
 * lightweight "nano"/"mini" tiers stream first tokens fastest; reasoning
 * models ("o1", "o3", …) are the slowest because they think before answering.
 * Used to pick a sensible default model automatically.
 */
function openAiSpeedRank(id: string): number {
  const lower = id.toLowerCase();
  if (/^o\d/.test(lower)) return 5; // reasoning models — slowest
  if (lower.includes('nano')) return 0;
  if (lower.includes('mini')) return 1;
  if (lower.includes('turbo')) return 2;
  return 3;
}

/**
 * Pick the fastest-responding chat model from a list returned by the API.
 * Filters to chat-capable models, then sorts by latency rank (preserving the
 * API's order on ties). Returns null when no chat model is available.
 */
export function pickFastestOpenAiModel(models: string[]): string | null {
  const chat = models.filter(isOpenAiChatModel);
  if (!chat.length) return null;
  return chat
    .map((id, index) => ({ id, index, rank: openAiSpeedRank(id) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)[0].id;
}

/** List models from the OpenAI API via GET /v1/models. */
async function fetchOpenAiModels(apiKey: string): Promise<string[]> {
  const data = await probeJson(`${OPENAI_BASE_URL}/v1/models`, { apiKey });
  const models = Array.isArray(data?.data) ? data.data : [];
  return models.map((m: any) => m?.id).filter((id: any): id is string => !!id);
}

async function resolveOpenAiModel(config: AIServiceConfig): Promise<string> {
  if (config.openaiModel.trim()) return config.openaiModel.trim();
  const models = await fetchOpenAiModels(config.openaiApiKey);
  const fastest = pickFastestOpenAiModel(models);
  if (!fastest) {
    throw new Error('No OpenAI chat models available for this API key.');
  }
  return fastest;
}

async function streamOpenAi(
  systemPrompt: string,
  userContent: string,
  config: AIServiceConfig,
  onToken: TokenHandler
): Promise<string> {
  if (!config.openaiApiKey.trim()) {
    throw new Error('OpenAI API key not configured. Set it in Settings.');
  }

  const model = await resolveOpenAiModel(config);

  const res = await tauriFetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: openAiHeaders(config.openaiApiKey),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      stream: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI request failed — ${await responseDetail(res)}`);
  }

  const full = await consumeStream(res, parseOpenAiLine, onToken);
  if (!full.trim()) {
    throw new Error('No response from OpenAI');
  }
  return full.trim();
}

// ---------- Connection checks (used by Settings) ----------

export interface OmlxCheckResult {
  ok: boolean;
  models: string[];
  error?: string;
}

export async function checkOmlx(
  serverUrl: string,
  apiKey: string
): Promise<OmlxCheckResult> {
  try {
    const models = await fetchOmlxModels(serverUrl, apiKey);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, models: [], error: errorDetail(err) };
  }
}

export interface OllamaCheckResult {
  ok: boolean;
  models: string[];
  error?: string;
}

export async function checkOllama(serverUrl: string): Promise<OllamaCheckResult> {
  try {
    const models = await fetchOllamaModels(serverUrl);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, models: [], error: errorDetail(err) };
  }
}

export interface OpenAiCheckResult {
  ok: boolean;
  models: string[];
  error?: string;
}

/**
 * Verify the OpenAI API key by listing available models. Returns only the
 * chat-capable models, ordered fastest-first so the caller can default to the
 * quickest-responding one.
 */
export async function checkOpenAi(apiKey: string): Promise<OpenAiCheckResult> {
  if (!apiKey.trim()) return { ok: false, models: [], error: 'API key is required' };
  try {
    const all = await fetchOpenAiModels(apiKey);
    const fastest = pickFastestOpenAiModel(all);
    const chat = all.filter(isOpenAiChatModel);
    // Surface the fastest model first; keep the rest in API order.
    const ordered = fastest ? [fastest, ...chat.filter((m) => m !== fastest)] : chat;
    return { ok: true, models: ordered };
  } catch (err) {
    return { ok: false, models: [], error: errorDetail(err) };
  }
}

export interface CustomCheckResult {
  ok: boolean;
  error?: string;
}

/**
 * Lightweight verification for the Custom provider: fires a minimal
 * non-streaming chat request and checks for a usable HTTP response.
 */
export async function checkCustom(
  endpoint: string,
  model: string,
  apiKey: string
): Promise<CustomCheckResult> {
  if (!endpoint.trim()) return { ok: false, error: 'Endpoint URL is required' };
  if (!model.trim()) return { ok: false, error: 'Model name is required' };

  try {
    const { status, body } = await httpProbe(endpoint.trim(), {
      method: 'POST',
      apiKey: apiKey.trim() || undefined,
      body: JSON.stringify({
        model: model.trim(),
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
      }),
    });

    if (status < 200 || status >= 300) {
      const detail = body.trim().slice(0, 400);
      return { ok: false, error: `HTTP ${status}${detail ? `: ${detail}` : ''}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorDetail(err) };
  }
}
