# CAD source

The editable source for every printed or machined part. Always commit the source here,
not only the STL.

- Fusion 360: export the design as `.f3d` (File > Export) and commit that.
- Also commit a `.step` export of each part so it opens without Fusion.
- Name files `<part>-v<N>.<ext>`, lowercase with dashes: `pen-carriage-v2.f3d`,
  `pen-carriage-v2.step`. Bump N when the part changes in a way that needs a reprint.

Do not commit: Fusion cache or lock files, renders, or screenshots (put photos in
[`../../docs`](../../docs)).
