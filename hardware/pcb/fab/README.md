# Fab orders

Only the gerber and drill files that were actually ordered, one folder per order:

```
fab/
  v1-2026-11/
    pen-plotter-v1-gerbers.zip
    notes.md        # fab house, order number, options (layers, thickness, finish), cost
```

- Folder name: `v<N>-<YYYY-MM>`, where N matches the board revision in the KiCad
  project and the date is when the order was placed.
- Commit the exact zip you uploaded, so the folder matches what came back.
- Tag the commit that produced the order, e.g. `pcb-v1`.

Do not commit: gerbers from boards that were never ordered, or exports to try out
the fab's viewer. Regenerate those from the KiCad project.
