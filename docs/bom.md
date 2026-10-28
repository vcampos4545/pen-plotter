# Bill of materials

Parts named in [`../firmware/README.md`](../firmware/README.md) and
[`../firmware/config.yaml`](../firmware/config.yaml). Fill in sources as parts are
bought. Add printed parts and fasteners as the mechanical design settles.

| Part | Qty | Source / link | Notes |
| ---- | --- | ------------- | ----- |
| ESP-WROOM-32 dev board (ESP32 DevKit) | 1 | | 30-pin or 38-pin; check pin labels |
| TMC2209 driver module (StepStick) | 2 | | X at UART address 0, Y at address 1 |
| NEMA 17 stepper | 2 | | X pen carriage, Y paper tray |
| MG90S servo | 1 | | Z pen lift |
| GT2 belt (2 mm pitch) | | | Length depends on frame |
| GT2 20-tooth pulley | 2 | | 40 mm per turn, 80 steps/mm |
| 12 V 5 A supply | 1 | | |
| 12 V to 5 V buck converter, ~3 A | 1 | | Powers the ESP32 and servo |
| 100 µF electrolytic capacitor, 25 V+ | 2 | | One per driver |
| 1 kΩ resistor | 1 | | UART TX |
| 10 kΩ resistor | 1 | | Optional; keeps drivers off at boot |
