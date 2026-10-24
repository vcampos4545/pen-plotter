# Pen Plotter

A local web app for sketching on a 2-axis pen plotter and sending the drawing to it
over WiFi. The plotter is an ESP32 running [FluidNC](https://github.com/bdring/FluidNC):
one NEMA 17 moves the paper tray, one moves the pen, and an MG90S servo on the Z axis
lifts the pen. The browser talks to FluidNC's WebSocket directly. Nothing is hosted
on the ESP32.

The controller's FluidNC `config.yaml`, wiring and first power-on steps are in
[firmware/README.md](firmware/README.md).

## Run it

Needs Node 20 or newer.

```sh
npm install
npm run dev        # serves the app at http://localhost:5173
npm test           # unit + simulator integration tests (Vitest)
npm run build      # typecheck and production build into dist/
```

## Using the app

- **Tools**: Pen (freehand), Line, Rect, Ellipse, Eraser (deletes a whole stroke),
  Undo/Redo, Clear. Shortcuts: `P` `L` `R` `O` `E`, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z.
  Hold Shift for a square, a circle, or a line snapped to 15°.
- The sheet is drawn at its real aspect ratio. The dashed box is the margin; points
  are clamped to it while drawing. The red dot marks machine X0 Y0.
- The drawing is saved in localStorage on every change. Use **SVG** / **JSON** to
  export and **Import** to load them back. SVG import accepts `polyline`, `polygon`,
  `line` and straight-segment `path` elements; curves are rejected.
- **Topo** opens a world map for drawing contour lines of real terrain. See
  [Topo lines](#topo-lines) below.
- **Photo** turns a photo into lines: squiggles, a spiral, hatching, outlines or TSP
  art. See [Photo to lines](#photo-to-lines) below. Dropping a photo on the sheet
  opens it too.
- **Send to Plotter** runs flatten → simplify → optimize → G-code → stream. It is
  disabled unless the indicator says Connected and the drawing is inside the margin.
  **Download G-code** saves the same program to a file.
- The stats panel shows pen-up travel as drawn vs. after optimization. Tick
  **Show pen-up moves** to overlay the planned travel in red.
- **Job** shows lines sent and acknowledged and a percentage, with Pause, Resume and Stop.
- **Machine** has Unlock (`$X`), Pen up/down, To origin, and a console for one-off commands.
  These are disabled while a job runs.

### Topo lines

1. Press **Topo**. Pan and zoom the map to a place.
2. Press **Select area** (or hold Shift) and drag a box. The elevation for the box
   downloads and the contours appear in the preview on the right, in blue on top of
   the current drawing.
3. Adjust the controls. The preview updates without downloading again.
   - **Contours**: a line every N metres, or N evenly spaced levels. When a new area
     would get fewer than 3 or more than 250 lines at the current interval, the
     interval is reset to a round number giving about 20.
   - **Smoothing**: blur passes over the elevation before contouring. More passes give
     calmer lines and fewer tiny loops.
   - **Simplify**: point reduction tolerance on the paper, in mm.
   - **Drop lines shorter than**: fragments below this length on the paper are left out
     so the plotter does not spend time on noise.
4. Press **Add to drawing**. The contours become ordinary strokes, added as one undo
   step, so undo, export, the planner, stats and Send treat them like anything drawn
   by hand.

**Match paper shape** (on by default) locks the box to the shape of the drawable area,
measured on the ground, so the contours fill the sheet. Turn it off to select any
shape. The contours are always fitted inside the margin at the box's true proportions:
east-west distance is scaled by the cosine of the box's middle latitude, so a box far
from the equator is not stretched sideways. Large or very wide boxes leave unused paper
when the lock is off.

Elevation comes from the [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
(Terrarium PNG tiles, no key needed). The zoom level is chosen so the box's longer side
covers at least 400 source pixels, capped at 16 tiles per box and zoom 15. The elevation
is resampled to a grid of 300 samples on the box's longer side and contoured with
marching squares. A Topo session needs an internet connection; a failed download says
which tile failed and offers **Retry download**. An area with no contours at the chosen
settings (flat ground, or an interval larger than the elevation range) says so instead
of adding nothing silently.

The tested parts are `src/terrain.ts` (tile math, Terrarium decoding, stitching,
resampling, the aspect lock), `src/contour.ts` (smoothing, levels, marching squares)
and `src/topo.ts` (fitting to the paper and dropping fragments). `src/topo-ui.ts` is the
dialog and map wiring and loads only when **Topo** is first opened.

**Attribution.** The map's corner credits OpenStreetMap and the Terrain Tiles, and
**Elevation data sources** under the dialog's buttons holds the full terrain credit:

- Map tiles and data © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors.
- Elevation from the Terrain Tiles. Their
  [required attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
  is: ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and
  funded under National Science Foundation awards 1043681, 1559691, and 1542736;
  Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;
  Austria terrain data © offene Daten Österreichs, Digitales Geländemodell (DGM)
  Österreich; Canada terrain data contains information licensed under the Open
  Government Licence, Canada; Europe terrain data produced using Copernicus data and
  information funded by the European Union, EU-DEM layers; Global ETOPO1 terrain data
  U.S. National Oceanic and Atmospheric Administration; Mexico terrain data source:
  INEGI, Continental relief, 2016; New Zealand terrain data Copyright 2011 Crown
  copyright (c) Land Information New Zealand and the New Zealand Government (All rights
  reserved); Norway terrain data © Kartverket; United Kingdom terrain data ©
  Environment Agency copyright and/or database right 2015. All rights reserved; United
  States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the
  U.S. Geological Survey.

The map tiles come from `tile.openstreetmap.org`, which is fine for this kind of light
personal use under the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

### Photo to lines

1. Press **Photo**, then **Choose photo…** or drop a JPEG, PNG or WebP on the dialog
   (or on the sheet). The image is decoded in the browser and never uploaded.
2. Pick a **Style** and **Framing**. **Crop to fill** cuts the photo to the shape of
   the drawable area so the lines fill the sheet; **Fit whole photo** keeps all of it
   and leaves margins. The thumbnail shows the photo as the generator sees it.
3. Adjust **Brightness**, **Contrast** and **Gamma** (above 1 lightens mid-tones), or
   tick **Invert**. Then tune the style:
   - **Squiggle lines**: rows across the sheet whose wave grows taller and tighter
     where the photo is darker. *Rows*, *Max amplitude* (× the row gap; 0.5 lets
     neighbouring rows touch) and *Frequency* (waves per mm at full black).
   - **Spiral**: one line from the centre out to the largest circle that fits, with a
     radial wobble in dark areas. The pen never lifts. *Ring spacing*, *Max amplitude*
     (× spacing) and *Frequency*.
   - **Hatching**: straight lines at *Line spacing* and *Angle*. Each of the 1 to 4
     *Layers* adds a direction (+90°, +45°, −45°) where the photo is darker than its
     threshold (evenly spaced, e.g. 25%, 50%, 75% for three layers).
   - **Outline**: Canny-style edge detection (blur, Sobel, thin edges, hysteresis)
     traced into lines. *Smoothing* blurs first, a higher *Edge threshold* keeps only
     strong edges, and *Drop lines shorter than* removes specks.
   - **TSP art**: *Points* stipples placed by darkness (weighted Lloyd relaxation),
     joined into one continuous path by a nearest-neighbour tour improved with 2-opt.
     *Time limit* caps stippling plus path optimization.
4. The preview shows the lines in blue on the sheet, with the line count, points,
   pen-down length, an approximate pen-up distance and draw time. A warning appears
   for jobs over 2 hours, drawings too big to autosave (over 200,000 points: export
   JSON to keep them) and more than 8,000 separate lines (slow path planning).
5. Press **Add to drawing**. The lines become ordinary strokes, added as one undo step.

Lines are generated in a Web Worker, so the dialog stays responsive while TSP runs.
The photo is scaled to at most 640 pixels on its longer side for processing. The
settings are remembered; the photo is not. The tested parts are `src/tone.ts`
(luminance, tone adjustments, sampling), `src/photo-styles.ts` (squiggle, spiral,
hatching), `src/edges.ts` (edge detection and tracing), `src/stipple.ts` (stippling,
tour and line ordering) and `src/photo.ts` (framing, options, the pipeline and the
estimate). `src/photo-ui.ts` is the dialog wiring and loads only when **Photo** is
first opened.

### Connection indicator

| State        | Meaning |
| ------------ | ------- |
| Disconnected | Not trying to connect (you pressed Disconnect). |
| Connecting   | Socket opening, or open but no recent reply to `?`. |
| Connected    | Socket open and FluidNC answered a `?` status query in the last 2.5 s. |
| Streaming    | A job is running (Paused / Stopping shown next to it). |
| Error        | The socket failed or FluidNC stopped answering. Retries with backoff (1 s doubling to 15 s). |

The app polls `?` every 500 ms and shows the machine state and position in the top bar
and as a green crosshair on the sheet.

## Point it at the plotter

Open **Settings** and set:

- **Host**: defaults to `plotter.local`. FluidNC's default hostname is `fluidnc`, so
  either run `$Hostname=plotter` on the controller once (then restart it; see
  [firmware/README.md](firmware/README.md#wifi-and-hostname)) or type its current name
  or IP address here.
- **WebSocket port**: `80` for FluidNC v4.x (the current release line). Use `81` for v3.x.
- **WebSocket path**: `/`.

Settings are saved in localStorage. Changing host, port or path reconnects.

Other settings: paper width/height and margin (default 400 × 400 mm, 10 mm margin),
which paper corner is machine X0 Y0 (default bottom-left), pen up/down Z (default Z5 / Z0),
dwell after each pen move (default 0.15 s), draw and travel feeds, freehand
simplification tolerance (default 0.2 mm), endpoint-join tolerance, the optimizer
time limit, and how many lines may be in flight.

## What FluidNC's WebSocket looks like

Checked against the FluidNC source (`FluidNC/src/WebUI/WebUIServer.cpp` and
`WSChannel.cpp`) at release v4.1.1 and `main` in October 2026, and against v3.9.9:

- **Port and path.** v4.x moved to ESPAsyncWebServer and registers the socket as
  `AsyncWebSocket("/")` on the HTTP server, so it is `ws://<host>:80/` (it follows the
  `HTTP/Port` setting, `$HTTP/Port`). v3.x ran separate `WebSocketsServer`s on HTTP
  port + 1 (`81`, used by WebUI v2) and + 2 (`82`, subprotocol `webui-v3`).
- **Client to FluidNC.** Text or binary frames are fed byte by byte into the same channel
  as serial. Realtime characters (`?`, `!`, `~`, `0x18`) act immediately wherever they
  appear. Everything else is buffered until `\n`. A text frame that starts with
  `PING:` is answered by the WebUI keepalive and not treated as input. The app sends one
  line per frame and each realtime character as its own frame.
- **FluidNC to client.** Console output (`ok`, `error:N`, `ALARM:N`, `<...>` status
  reports, `[MSG:...]`) arrives as **binary** frames of plain text. Output is
  coalesced: one frame can hold several lines or end mid-line (flush at ~1400 bytes or
  after 8 ms idle), so the app reassembles lines across frames. WebUI bookkeeping
  arrives as short **text** frames such as `currentID:3` and `CURRENT_ID:3`, which the
  app ignores.
- **Auto reports.** v4 turns on automatic status reports for WebSocket channels (200 ms
  interval). The app still polls `?` and treats either kind of report as a reply.
- **Sessions.** In v4 a new socket closes older sockets from the same browser session
  (the session cookie, or empty without one). Keep only one tab of this app open. If you
  need several independent clients, adding `?independent_session` to the path gives
  each socket its own session.

## Streaming and stopping

- Lines are streamed with ok-counting flow control. At most **Lines in flight**
  (default 4) are unacknowledged. Each `ok` releases the next line. The job is never
  sent as one message.
- When every line is acknowledged the job is "finishing moves" until FluidNC reports Idle.
- **Pause** sends `!` (feed hold) and stops sending. **Resume** sends `~`.
- **Stop** sends a soft reset (`0x18`). A reset during motion leaves FluidNC in Alarm,
  so once the startup banner comes back (or after 2.5 s) the app sends `$X` and then
  `G21 G90 G0 Z<pen up>` to lift the pen.
- An `error:` or `ALARM:` reply during a job aborts it with the same sequence and shows
  the failing line. If the socket drops mid-job, the job is marked failed. The machine
  may still finish the few moves it had already buffered.

## Path planning and G-code

Planning is in `src/planner.ts` and G-code generation is in `src/gcode.ts`. Both are pure
and unit tested. The pipeline is `buildJob` in `src/job.ts`.

1. Freehand strokes are simplified with Ramer-Douglas-Peucker. Ellipses are flattened
   to chords within 0.05 mm.
2. Paper coordinates (origin top-left, Y down) are mapped to machine coordinates. With
   the default bottom-left origin, Y is flipped.
3. Every point must lie inside the paper minus the margin. Otherwise nothing is
   generated or sent.
4. Strokes whose endpoints touch (within the join tolerance) are merged so the pen stays down.
5. Greedy nearest neighbor from X0 Y0 picks each next stroke and its direction. Then a
   2-opt pass with stroke reversal improves the order until it converges or hits the
   time limit (default 1 s).
6. G-code: `G21 G90`, pen up, then per stroke `G0` to the start, pen down,
   `G1 ... F<draw feed>`, pen up. It ends with `G0 X0 Y0`. Every pen change is a `G0 Z`
   move followed by `G4 P<dwell>`.

FluidNC runs `G0` at each axis' `max_rate_mm_per_min` and ignores `F`. So **Travel feed**
only matters for the time estimate, unless you enable **Pen-up moves as G1 at travel
feed**, which emits travel as `G1 ... F<travel feed>`.

## Simulator

`npm run sim` starts a mock FluidNC WebSocket server at `ws://127.0.0.1:8081/`. To use it,
set Host `127.0.0.1`, Port `8081` and Path `/` in Settings.

```sh
npm run sim                             # defaults: port 8081, 20x faster than real time
npm run sim -- --port 9000 --speedup 5  # slower, easier to watch pause/stop
SIM_VERBOSE=1 npm run sim               # log every received line
```

It mimics the parts of FluidNC the app relies on: binary output frames coalesced like
the firmware, `currentID` text frames on connect, `?` status reports with live position,
`!` / `~` hold and resume, and `0x18` soft reset (`ALARM:3` if it interrupts motion, then
the banner). It acks each line with `ok` when its simulated move finishes. Malformed or
unsupported lines get `error:N`, G-code in Alarm gets `error:9`, and it supports `$X`.

`test/sim.integration.test.ts` runs the real connection and streamer against it: the
connected handshake, a full job under flow control, pause/resume, stop with pen lift,
abort on `error:`, and reconnect after the server restarts.

## Not done yet

Limit switches and homing (the config has the steps for adding them), hosting the app
on the ESP32, multiple pens or widths, colour separation, and SVG curve import.
