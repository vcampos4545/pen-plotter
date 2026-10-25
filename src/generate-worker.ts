import type { Rect } from './geometry';
import { buildGenerate, type GenerateOptions, type GenerateResult } from './generate';

// Runs the math-art generators off the main thread so the dialog stays
// responsive while a dense flow field or attractor is computed.

export interface GenerateRequest {
  id: number;
  area: Rect;
  options: GenerateOptions;
}

export type GenerateReply = { id: number; result: GenerateResult; ms: number } | { id: number; error: string };

self.onmessage = (e: MessageEvent<GenerateRequest>) => {
  const { id, area, options } = e.data;
  const started = performance.now();
  let reply: GenerateReply;
  try {
    reply = { id, result: buildGenerate(area, options), ms: performance.now() - started };
  } catch (err) {
    reply = { id, error: (err as Error).message };
  }
  self.postMessage(reply);
};
