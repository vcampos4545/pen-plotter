# PCB

KiCad project for the controller board: open `PenPlotter.kicad_pro` in KiCad. KiCad files are plain text and diff well, so
commit them as-is.

Commit:

- `*.kicad_pro`, `*.kicad_sch`, `*.kicad_pcb`
- Project-local libraries: `*.kicad_sym`, `*.pretty/` footprint folders (`*.kicad_mod`),
  `sym-lib-table`, `fp-lib-table`
- 3D models the board references, if they are not in the stock KiCad libraries

Do not commit (already in `.gitignore`): `*.kicad_prl` (per-user view state),
`*-backups/`, `fp-info-cache`, `_autosave-*`, `#auto_saved_files#`, `*.lck`, `.history/` (KiCad local history).

Gerbers are generated output. Do not commit them here; see [`fab/`](fab/).
