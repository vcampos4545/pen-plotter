import { decodeTerrarium, terrariumUrl, TILE_SIZE, type TileLoader } from './terrain';

// Browser-only: download one Terrarium PNG and read its pixels. The tests use
// a fake TileLoader instead, so nothing here runs under Vitest.

export function terrariumLoader(signal?: AbortSignal): TileLoader {
  return async (z, x, y) => {
    let res: Response;
    try {
      res = await fetch(terrariumUrl(z, x, y), { signal, mode: 'cors' });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error(`Network error fetching elevation tile ${z}/${x}/${y}. Check the internet connection.`);
    }
    if (!res.ok) throw new Error(`Elevation tile ${z}/${x}/${y} returned HTTP ${res.status}`);
    // No colour management or premultiplication: the RGB bytes are data, not colour.
    const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    if (bmp.width !== TILE_SIZE || bmp.height !== TILE_SIZE) throw new Error(`Elevation tile ${z}/${x}/${y} is ${bmp.width}×${bmp.height}`);
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return decodeTerrarium(ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data, TILE_SIZE, TILE_SIZE);
  };
}
