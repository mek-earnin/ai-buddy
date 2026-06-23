import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { AIProvider } from './types';
import { tauriFetch } from './http';

export interface AIServiceConfig {
  provider: AIProvider;
  openaiApiKey: string;
  anthropicApiKey: string;
  openaiModel: string;
  anthropicModel: string;
}

export type TokenHandler = (delta: string) => void;

export async function generateText(
  systemPrompt: string,
  userContent: string,
  config: AIServiceConfig
): Promise<string> {
  switch (config.provider) {
    case 'anthropic':
      return generateWithAnthropic(systemPrompt, userContent, config);
    case 'openai':
    default:
      return generateWithOpenAI(systemPrompt, userContent, config);
  }
}

/**
 * Streaming variant: invokes `onToken` for each text delta and resolves with the
 * full text. Powers the live "typing" result in the command palette.
 */
export async function generateTextStream(
  systemPrompt: string,
  userContent: string,
  config: AIServiceConfig,
  onToken: TokenHandler
): Promise<string> {
  switch (config.provider) {
    case 'anthropic':
      return streamWithAnthropic(systemPrompt, userContent, config, onToken);
    case 'openai':
    default:
      return streamWithOpenAI(systemPrompt, userContent, config, onToken);
  }
}

async function streamWithOpenAI(
  systemPrompt: string,
  userContent: string,
  config: AIServiceConfig,
  onToken: TokenHandler
): Promise<string> {
  if (!config.openaiApiKey) {
    throw new Error('OpenAI API key not configured. Add your key in Settings.');
  }

  const client = new OpenAI({
    apiKey: config.openaiApiKey,
    baseURL: 'https://api.openai.com/v1',
    fetch: tauriFetch as any,
    dangerouslyAllowBrowser: true,
  });

  const stream = await client.chat.completions.create({
    model: config.openaiModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
    max_tokens: 2048,
    stream: true,
  });

  let full = '';
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      full += delta;
      onToken(delta);
    }
  }

  if (!full.trim()) {
    throw new Error('No response from OpenAI');
  }
  return full.trim();
}

async function streamWithAnthropic(
  systemPrompt: string,
  userContent: string,
  config: AIServiceConfig,
  onToken: TokenHandler
): Promise<string> {
  if (!config.anthropicApiKey) {
    throw new Error('Anthropic API key not configured. Add your key in Settings.');
  }

  const client = new Anthropic({
    apiKey: config.anthropicApiKey,
    fetch: tauriFetch as any,
    dangerouslyAllowBrowser: true,
  });

  const stream = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    stream: true,
  });

  let full = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      full += event.delta.text;
      onToken(event.delta.text);
    }
  }

  if (!full.trim()) {
    throw new Error('No response from Anthropic');
  }
  return full.trim();
}

async function generateWithOpenAI(
  systemPrompt: string,
  userContent: string,
  config: AIServiceConfig
): Promise<string> {
  if (!config.openaiApiKey) {
    throw new Error('OpenAI API key not configured. Add your key in Settings.');
  }

  const client = new OpenAI({
    apiKey: config.openaiApiKey,
    baseURL: 'https://api.openai.com/v1',
    fetch: tauriFetch as any,
    dangerouslyAllowBrowser: true,
  });

  const response = await client.chat.completions.create({
    model: config.openaiModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
    max_tokens: 2048,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('No response from OpenAI');
  }
  return content.trim();
}

async function generateWithAnthropic(
  systemPrompt: string,
  userContent: string,
  config: AIServiceConfig
): Promise<string> {
  if (!config.anthropicApiKey) {
    throw new Error('Anthropic API key not configured. Add your key in Settings.');
  }

  const client = new Anthropic({
    apiKey: config.anthropicApiKey,
    fetch: tauriFetch as any,
    dangerouslyAllowBrowser: true,
  });

  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const block = response.content[0];
  if (block.type !== 'text') {
    throw new Error('Unexpected response type from Anthropic');
  }
  return block.text.trim();
}
