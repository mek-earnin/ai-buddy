import { AIProvider } from './types';
import { tauriFetch } from './http';

export interface AIServiceConfig {
  provider: AIProvider;
  ollamaServerUrl: string;
  ollamaModel: string;
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
 * this service only covers the HTTP providers (`ollama`, `custom`).
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
    default:
      return streamOllama(systemPrompt, userContent, config, onToken);
  }
}

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
  const res = await tauriFetch(`${base}/api/tags`, { method: 'GET' });
  if (!res.ok) {
    throw new Error(await responseDetail(res));
  }
  const data = await res.json();
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

// ---------- Connection checks (used by Settings) ----------

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
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;

    const res = await tauriFetch(endpoint.trim(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model.trim(),
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
      }),
    });

    if (!res.ok) {
      return { ok: false, error: await responseDetail(res) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorDetail(err) };
  }
}
