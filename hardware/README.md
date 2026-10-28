# Hardware

Physical design files for the plotter. Firmware lives in [`../firmware`](../firmware),
build notes and the BOM in [`../docs`](../docs).

| Folder | What goes in it |
| ------ | --------------- |
| [`cad/`](cad/) | CAD source: Fusion `.f3d` and STEP exports |
| [`stl/`](stl/) | Printable exports (STL or 3MF) made from `cad/` |
| [`pcb/`](pcb/) | KiCad project: schematic, board, local libraries |
| [`pcb/fab/`](pcb/fab/) | Gerbers and drill files actually sent to a fab, one folder per order |

Git LFS is not set up. Files here are small enough for plain git. Revisit if a single
file gets past ~50 MB.
