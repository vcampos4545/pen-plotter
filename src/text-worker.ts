import type { Rect } from './geometry';
import { buildText, CUSTOM_FONT, type TextOptions, type TextResult } from './text';
import { fontFromBytes, loadBundledFont } from './text-fonts';
import type { TextFont } from './text-layout';

// Lays out and fills text off the main thread: fills on big text can take a while.

export interface TextRequest {
  id: number;
  area: Rect;
  options: TextOptions;
  /** The user's own font file, when `options.font` is the custom font. */
  custom?: { key: string; bytes: ArrayBuffer };
}

export type TextReply = { id: number; result: TextResult; ms: number } | { id: number; error: string };

const fonts = new Map<string, Promise<TextFont>>();

function font(req: TextRequest): Promise<TextFont> {
  const custom = req.options.font === CUSTOM_FONT;
  if (custom && !req.custom) return Promise.reject(new Error('Load a font file first'));
  const key = custom ? `custom:${req.custom!.key}` : req.options.font;
  let f = fonts.get(key);
  if (!f) {
    f = custom ? Promise.resolve().then(() => fontFromBytes(req.custom!.bytes)) : loadBundledFont(key);
    // A failed load is retried next time instead of sticking.
    f.catch(() => fonts.delete(key));
    fonts.set(key, f);
  }
  return f;
}

self.onmessage = async (e: MessageEvent<TextRequest>) => {
  const { id, area, options } = e.data;
  const started = performance.now();
  let reply: TextReply;
  try {
    reply = { id, result: buildText(area, options, await font(e.data)), ms: performance.now() - started };
  } catch (err) {
    reply = { id, error: (err as Error).message };
  }
  self.postMessage(reply);
};
