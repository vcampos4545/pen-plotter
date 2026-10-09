# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Correct entries that work proves wrong; add new ones only by deliberate maintainer choice, never as routine task output.

## Project notes

- Commands: `npm test` (Vitest, includes the simulator integration test), `npm run typecheck`, `npm run build`, `npm run dev`, `npm run sim`. Run test + typecheck before committing.
- Pure, tested logic lives in `src/planner.ts`, `src/gcode.ts`, `src/job.ts` (the Send pipeline), `src/protocol.ts`, `src/streamer.ts`. `src/main.ts` is DOM wiring only; keep new logic out of it so it stays testable.
- Units are mm everywhere. Paper space is top-left origin, Y down; machine space comes from `toMachine` in `src/gcode.ts`.
- FluidNC WebSocket facts (port 80 path `/` on v4, 81 on v3, binary output frames, coalesced lines) are recorded in the README; check FluidNC source before changing protocol code.
- `sim/mock-fluidnc.mjs` must keep matching the real firmware's framing; the integration test drives the real `FluidNCConnection` against it.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
