import { buildPhoto, type PhotoInput, type PhotoResult } from './photo';

// Runs the Photo line generators off the main thread so the dialog stays
// responsive while TSP or a large hatch is computed.

export interface PhotoRequest {
  id: number;
  input: PhotoInput;
}

export type PhotoReply = { id: number; result: PhotoResult; ms: number } | { id: number; error: string };

self.onmessage = (e: MessageEvent<PhotoRequest>) => {
  const { id, input } = e.data;
  const started = performance.now();
  let reply: PhotoReply;
  try {
    reply = { id, result: buildPhoto(input), ms: performance.now() - started };
  } catch (err) {
    reply = { id, error: (err as Error).message };
  }
  self.postMessage(reply);
};
