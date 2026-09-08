/* ============================================================================
   api/chat — streaming inference console transport (POST /api/llm/{id}/chat).

   The backend relays the node-side vLLM stream and appends a terminal stats
   frame; frames seen in the wild:

     data: {"delta":{"content":"hel"}}        ← assistant delta pieces
     data: {"stats":{"ttft_ms":312,"tps":41.7,"output_tokens":128,
                     "prompt_tokens":24,"total_ms":3106}}   ← terminal frame
     data: {"__error":"http_502: …"}          ← relay error (string payload)
     data: [DONE]                             ← sentinel

   Implemented with fetch + ReadableStream (not EventSource) because the
   request is a POST with a JSON body, plus Bearer auth.
   ========================================================================= */

import { ApiClientError, apiBaseUrl, getAuthToken } from './client';
import type { ChatMsg, ChatRequest, ChatStatsFrame, ID } from './types';

export interface ChatStreamHandlers {
  /** Called per assistant text piece (deltas are appended client-side). */
  onDelta: (text: string) => void;
  /** Terminal frame with TTFT/TPS — arrives right before [DONE]. */
  onStats: (stats: ChatStatsFrame['stats']) => void;
  /** Relay error transport (backend error shape or stream failure). */
  onError: (message: string) => void;
}

export interface ChatStreamOptions {
  clusterId: ID;
  body: ChatRequest;
  handlers: ChatStreamHandlers;
  signal?: AbortSignal;
}

type StreamFrame =
  | { kind: 'delta'; text: string }
  | { kind: 'stats'; stats: ChatStatsFrame['stats'] }
  | { kind: 'error'; message: string }
  | { kind: 'done' };

function parseFramePayload(payload: string): StreamFrame | null {
  if (payload === '[DONE]') return { kind: 'done' };
  let json: unknown;
  try {
    json = JSON.parse(payload) as unknown;
  } catch {
    return null; // tolerate non-JSON comments/keepalives
  }
  if (json === null || typeof json !== 'object') return null;
  const obj = json as {
    delta?: { content?: unknown } | null;
    stats?: unknown;
    __error?: unknown;
    error?: unknown;
    /* the live backend emits the stats body directly (docs drift — the
       pinned contract wraps it in {"stats": …}); both shapes accepted */
    ttft_ms?: unknown;
    tps?: unknown;
    output_tokens?: unknown;
    prompt_tokens?: unknown;
    total_ms?: unknown;
  };

  if (obj.__error !== undefined && obj.__error !== null) {
    const e = obj.__error;
    const message =
      typeof e === 'string'
        ? e
        : typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string'
          ? (e as { message: string }).message
          : JSON.stringify(e);
    return { kind: 'error', message };
  }

  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

  /* accept BOTH the pinned `{"stats": …}` wrapper and the live backend's
     bare stats body (`{"ttft_ms":…,"tps":…}`) — docs drift, see task report */
  const hasStatsShape = (o: unknown): boolean =>
    typeof o === 'object' && o !== null &&
    (typeof (o as Record<string, unknown>).ttft_ms === 'number' ||
      typeof (o as Record<string, unknown>).tps === 'number' ||
      typeof (o as Record<string, unknown>).output_tokens === 'number');

  const statsBody: unknown = hasStatsShape(obj) ? obj : typeof obj.stats === 'object' && hasStatsShape(obj.stats) ? obj.stats : null;
  if (statsBody !== null) {
    const st = statsBody as Record<string, unknown>;
    return {
      kind: 'stats',
      stats: {
        ttft_ms: num(st.ttft_ms) ?? 0,
        tps: num(st.tps) ?? 0,
        output_tokens: typeof st.output_tokens === 'number' ? st.output_tokens : 0,
        prompt_tokens: num(st.prompt_tokens),
        total_ms: num(st.total_ms) ?? 0,
      },
    };
  }

  const text = obj.delta !== null && obj.delta !== undefined && typeof obj.delta.content === 'string' ? obj.delta.content : null;
  if (text !== null) return { kind: 'delta', text };
  return null;
}

/** Stream one chat completion; resolves when the stream ends (or throws for
    transport-level failures — SSE-level errors arrive via `onError`). */
export async function streamChat(opts: ChatStreamOptions): Promise<void> {
  const { clusterId, body, handlers, signal } = opts;
  const base = apiBaseUrl();
  const url = `${base.replace(/\/+$/, '')}/api/llm/${encodeURIComponent(clusterId)}/chat`;

  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
  };
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body satisfies ChatRequest),
      signal,
      credentials: 'omit',
    });
  } catch (e) {
    if (signal?.aborted) return; // user cancellation is not an error
    throw new ApiClientError(
      'network',
      `Chat stream failed: ${String(e)}`,
      0,
      { cause: String(e) },
    );
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const json = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
      if (json.error && typeof json.error.message === 'string') {
        message = `${json.error.code ?? 'error'}: ${json.error.message}`;
      }
    } catch {
      /* plain error body */
    }
    handlers.onError(message);
    return;
  }

  const reader = res.body?.getReader();
  if (reader === undefined) {
    handlers.onError('Stream unavailable: response has no body');
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  const drainFrame = (raw: string): void => {
    for (const line of raw.split('\n')) {
      const trimmed = line.trimEnd();
      if (!trimmed.startsWith('data:')) continue; // SSE comments / empty lines
      const payload = trimmed.slice(5).trim();
      if (payload === '') continue;
      const frame = parseFramePayload(payload);
      switch (frame?.kind) {
        case 'delta':
          handlers.onDelta(frame.text);
          break;
        case 'stats':
          handlers.onStats(frame.stats);
          break;
        case 'error':
          handlers.onError(frame.message);
          break;
        case 'done':
          return; // sentinel — remaining buffer is ignored
        case undefined:
          /* tolerate keepalives */
          break;
      }
    }
  };

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n'); // CRLF-normalize (proxy-safe)
      // SSE frames are separated by a blank line ("data: …\n\n")
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const frameRaw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        drainFrame(frameRaw);
        idx = buffer.indexOf('\n\n');
      }
    }
    // flush any final unterminated frame (defensive — backend always ends \n\n)
    drainFrame(buffer);
  } catch (e) {
    if (signal?.aborted) return;
    handlers.onError(`stream read failed: ${String(e)}`);
  }
}

/** Convenience for composers: build the message list of a session turn. */
export function userMsg(content: string): ChatMsg {
  return { role: 'user', content };
}
