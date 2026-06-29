import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
export { tauriFetch };

export interface HttpProbeResponse {
  status: number;
  body: string;
}

/**
 * One-shot HTTP request used by the Settings "Verify connection" checks.
 *
 * The `@tauri-apps/plugin-http` fetch collapses transport errors to reqwest's
 * generic "error sending request for url (...)" and drops the source chain, so
 * the real failure cause (DNS, TLS/cert, connection refused, timeout) never
 * reaches the UI. This routes through a dedicated Rust command that walks the
 * full error chain and rejects with the actionable detail.
 */
export async function httpProbe(
  url: string,
  options?: { method?: 'GET' | 'POST' | 'PUT'; apiKey?: string; body?: string }
): Promise<HttpProbeResponse> {
  return invoke<HttpProbeResponse>('http_probe', {
    url,
    method: options?.method,
    apiKey: options?.apiKey,
    body: options?.body,
  });
}
