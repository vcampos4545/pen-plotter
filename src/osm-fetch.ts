import { OVERPASS_TIMEOUT, OVERPASS_URL, OverpassError, overpassError } from './osm';

// Browser-only: send one Overpass query. The tests feed parseOverpass canned
// replies instead, so nothing here runs under Vitest.

/** Give up a little after the server's own limit would have answered. */
const CLIENT_TIMEOUT_MS = (OVERPASS_TIMEOUT + 30) * 1000;

export async function fetchOverpass(query: string, signal: AbortSignal): Promise<unknown> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, CLIENT_TIMEOUT_MS);
  const cancel = () => ctrl.abort();
  signal.addEventListener('abort', cancel);
  try {
    let res: Response;
    try {
      res = await fetch(OVERPASS_URL, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      if (timedOut) throw new OverpassError('The Overpass server did not answer in time. Try again, or select a smaller area.', true);
      throw new OverpassError('Network error reaching the Overpass server. Check the internet connection, then press Retry.', true);
    }
    if (!res.ok) throw overpassError(res.status, await res.text().catch(() => ''));
    try {
      return await res.json();
    } catch (err) {
      if (signal.aborted) throw err;
      throw new OverpassError('The map data download was cut off or is not valid JSON. Press Retry.', true);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
