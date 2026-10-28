# Printable exports

STL or 3MF files ready to slice, exported from the source in [`../cad`](../cad).

- Same name and version as the source part: `pen-carriage-v2.stl`.
- Orient each part in its print orientation before export.
- Put print settings that matter (material, infill, supports) in
  [`../../docs/assembly.md`](../../docs/) or a note next to the file.

Do not commit: sliced output (`.gcode`, `.bgcode`; ignored under `hardware/`), slicer
project backups, or an STL without its CAD source in `cad/`.
