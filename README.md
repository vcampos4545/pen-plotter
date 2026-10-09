# Pen Plotter

A local web app for sketching on a 2-axis pen plotter and sending the drawing to it
over WiFi. The plotter is an ESP32 running [FluidNC](https://github.com/bdring/FluidNC):
one NEMA 17 moves the paper tray, one moves the pen, and an MG90S servo on the Z axis
lifts the pen. The browser talks to FluidNC's WebSocket directly. Nothing is hosted
on the ESP32.

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
- **Send to Plotter** runs flatten → simplify → optimize → G-code → stream. It is
  disabled unless the indicator says Connected and the drawing is inside the margin.
  **Download G-code** saves the same program to a file.
- The stats panel shows pen-up travel as drawn vs. after optimization. Tick
  **Show pen-up moves** to overlay the planned travel in red.
- **Job** shows lines sent and acknowledged and a percentage, with Pause, Resume and Stop.
- **Machine** has Unlock (`$X`), Pen up/down, To origin, and a console for one-off commands.
  These are disabled while a job runs.

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
  either run `$Hostname=plotter` on the controller once (then restart it) or type its
  current name or IP address here.
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

FluidNC `config.yaml` (pins, 80 steps/mm for GT2 + 20T pulleys at 16x microstepping, the
RC servo on Z), hosting the app on the ESP32, multiple pens or widths, and
image/SVG-to-line tracing.
