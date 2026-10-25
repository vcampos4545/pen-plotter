import L from 'leaflet';
import { boxFromCorners, lockAspect, type GeoBox, type LatLon } from './terrain';

// Drag a box on a Leaflet map, with a Select area button on or with Shift held.
// Shared by the map dialogs.

export interface BoxSelectOptions {
  /** True while the dialog's Select area button is on; Shift-drag always selects. */
  selecting(): boolean;
  /** Ground width / height to lock the box to, or undefined for any shape. */
  ratio(): number | undefined;
  /** A drag finished with a new box. */
  onSelect(box: GeoBox): void;
}

export function enableBoxSelect(m: L.Map, opts: BoxSelectOptions): void {
  const el = m.getContainer();
  let rect: L.Rectangle | undefined;
  let selected: GeoBox | undefined;
  let drag: { id: number; anchor: LatLon } | undefined;
  const at = (e: PointerEvent): LatLon => {
    const ll = m.mouseEventToLatLng(e);
    return { lat: ll.lat, lon: ll.lng };
  };
  const cornerFor = (e: PointerEvent): LatLon => {
    const ratio = opts.ratio();
    return ratio ? lockAspect(drag!.anchor, at(e), ratio) : at(e);
  };
  const showBox = (b: GeoBox) => {
    const bounds = L.latLngBounds([b.south, b.west], [b.north, b.east]);
    if (rect) rect.setBounds(bounds);
    else rect = L.rectangle(bounds, { color: '#2563eb', weight: 2, fillOpacity: 0.08, interactive: false }).addTo(m);
  };
  // Capture phase, ahead of Leaflet's own handlers, so a box drag never pans the map.
  el.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || !(opts.selecting() || e.shiftKey) || (e.target as Element).closest('.leaflet-control')) return;
      e.preventDefault();
      e.stopPropagation();
      m.dragging.disable();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointer; the drag still works while over the map.
      }
      drag = { id: e.pointerId, anchor: at(e) };
    },
    true,
  );
  el.addEventListener(
    'pointermove',
    (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      e.stopPropagation();
      showBox(boxFromCorners(drag.anchor, cornerFor(e)));
    },
    true,
  );
  const end = (e: PointerEvent, cancelled: boolean) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.stopPropagation();
    const b = boxFromCorners(drag.anchor, cornerFor(e));
    drag = undefined;
    m.dragging.enable();
    const sw = m.latLngToContainerPoint([b.south, b.west]);
    const ne = m.latLngToContainerPoint([b.north, b.east]);
    // A click rather than a drag: keep whatever was selected before.
    if (cancelled || Math.abs(ne.x - sw.x) < 6 || Math.abs(ne.y - sw.y) < 6) {
      if (selected) {
        showBox(selected);
      } else {
        rect?.remove();
        rect = undefined;
      }
      return;
    }
    selected = b;
    showBox(b);
    opts.onSelect(b);
  };
  el.addEventListener('pointerup', (e) => end(e, false), true);
  el.addEventListener('pointercancel', (e) => end(e, true), true);
}
