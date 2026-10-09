# Plotter firmware: FluidNC setup and wiring

This folder holds the controller side of the plotter: [`config.yaml`](config.yaml) for
[FluidNC](https://github.com/bdring/FluidNC), plus this guide to flashing, wiring and
first power-on.

The config targets **FluidNC v4.1.1**, the current release in October 2026. Every key
was checked against that release's source, and the file passes FluidNC's own validator
(`tools/validate_fluidnc_config.py`, see [Checking the config](#checking-the-config)).

| Axis | Moves            | Driver                   | Notes |
| ---- | ---------------- | ------------------------ | ----- |
| X    | pen carriage     | TMC2209, UART address 0  | 80 steps/mm, 400 mm travel |
| Y    | paper tray       | TMC2209, UART address 1  | 80 steps/mm, 400 mm travel |
| Z    | pen lift (MG90S) | RC servo PWM             | Z0 = pen down, Z5 = pen up |

80 steps/mm: a GT2 belt has a 2 mm pitch, so a 20-tooth pulley moves 40 mm per turn.
200 full steps × 16 microsteps / 40 mm = 80.

## Parts

- ESP-WROOM-32 dev board (ESP32 DevKit, 30-pin or 38-pin).
- 2 × TMC2209 driver modules (StepStick format).
- 2 × NEMA 17 steppers, 1 × MG90S servo.
- 12 V 5 A supply.
- 12 V to 5 V buck converter rated about 3 A.
- 2 × 100 µF electrolytic capacitors, 25 V or higher.
- 1 × 1 kΩ resistor (UART).
- Optional: 1 × 10 kΩ resistor (keeps the drivers off while the ESP32 boots).

## Wiring

> **Check pin labels against your own board.** ESP32 dev boards come in 30-pin and
> 38-pin versions, and the header order and silkscreen differ between makers (`25`,
> `D25`, `G25`, `IO25`). Everything below uses **GPIO numbers**, not header positions.
> Find each GPIO on your board's pinout diagram before wiring.

### ESP32 pin map

| ESP32 GPIO | Goes to | Why this pin |
| ---------- | ------- | ------------ |
| GPIO25 | X driver STEP | |
| GPIO26 | X driver DIR | |
| GPIO33 | Y driver STEP | |
| GPIO32 | Y driver DIR | |
| GPIO27 | EN on **both** drivers | One shared enable line |
| GPIO17 | UART TX, through 1 kΩ to the PDN_UART node | ESP32 UART1 |
| GPIO16 | UART RX, straight to the PDN_UART node | ESP32 UART1 |
| GPIO21 | Servo signal | Any PWM-capable output works |
| 3V3 | VIO on both drivers, MS1 on the Y driver | Logic supply |
| VIN / 5V | Buck converter 5 V out | Powers the board |
| GND | Common ground | |

All of these are ordinary outputs. The config avoids the boot strapping pins (0, 2, 5,
12, 15), the flash pins (6 to 11), the input-only pins (34 to 39), and GPIO1/GPIO3,
which carry the USB serial console.

### TMC2209 drivers

Module silkscreens vary. Match by pin name, not position.

| TMC2209 pin | X driver (pen carriage) | Y driver (paper tray) |
| ----------- | ----------------------- | --------------------- |
| STEP | GPIO25 | GPIO33 |
| DIR | GPIO26 | GPIO32 |
| EN | GPIO27 | GPIO27 |
| PDN_UART (sometimes labelled UART or PDN) | UART node (below) | UART node (below) |
| MS1 | GND | **3.3 V** |
| MS2 | GND | GND |
| VIO (VDD) | 3.3 V | 3.3 V |
| GND (logic side) | GND | GND |
| VM | 12 V | 12 V |
| GND (power side) | GND | GND |
| A1, A2 (or 1A, 1B) | X motor, coil A | Y motor, coil A |
| B1, B2 (or 2A, 2B) | X motor, coil B | Y motor, coil B |
| CLK, DIAG, INDEX, SPREAD | leave unconnected | leave unconnected |

**Address strapping.** In UART mode MS1 and MS2 set the driver's address, not its
microstepping: address = MS1 + 2 × MS2. X has both low (address 0), Y has MS1 high
(address 1). Wire MS1/MS2 to GND or 3.3 V explicitly rather than leaving them floating.

**Single-wire UART.** The TMC2209 uses one pin, PDN_UART, for both directions. Tie both
drivers' PDN_UART pins together. That is the UART node:

```
GPIO17 (TX) ──[ 1 kΩ ]──┬── PDN_UART, X driver
                        ├── PDN_UART, Y driver
GPIO16 (RX) ────────────┘
```

The resistor lets the driver override the ESP32's TX line when it replies. Some modules
only bring PDN_UART out to the header after you bridge a solder jumper (often marked
"UART"). Check your module's documentation.

**Enable line.** EN is active low: low runs the motors, high turns them off. Optional:
a 10 kΩ resistor from GPIO27 to 3.3 V keeps both drivers off while the ESP32 boots or
is being flashed, before FluidNC takes control of the pin.

**Motor coils.** A NEMA 17 has two coils. With the motor unplugged, measure resistance
between wire pairs: the two wires of one coil read a few ohms, wires from different
coils read open. Put one coil on A1/A2 and the other on B1/B2. Wire colours are not
standard between makers.

### Servo

| MG90S wire | Connects to |
| ---------- | ----------- |
| Orange or yellow (signal) | GPIO21 |
| Red (+) | Buck converter 5 V out |
| Brown or black (−) | GND |

Never power the servo from the ESP32's 3.3 V pin. The ESP32's 3.3 V signal is enough
to drive an MG90S.

### Power

```
12 V supply ──┬── VM, X driver   (100 µF across VM and GND, at the driver)
              ├── VM, Y driver   (100 µF across VM and GND, at the driver)
              └── buck converter in ── 5 V out ──┬── servo red
                                                 └── ESP32 VIN / 5V pin
All grounds joined: supply −, buck GND, ESP32 GND, both drivers' GNDs, servo brown.
```

- Set the buck converter's output to 5.0 V with a multimeter **before** connecting
  anything to it. Many cheap modules ship at a higher voltage.
- Put a 100 µF capacitor across VM and GND as close to each driver as possible. Mind
  the polarity (the stripe is −). It absorbs voltage spikes that can kill the driver.
- Every ground must be common. The UART, STEP and DIR signals need the shared ground
  to mean anything.
- **Never connect or disconnect a motor while the 12 V supply is on.** The driver can
  be destroyed instantly. Power off first, every time.
- Most dev boards have a diode between USB and the 5V pin, so plugging in USB while
  the buck converter is powered is fine. If yours has no such diode, disconnect the
  5V/VIN wire while you use USB.

## Flashing FluidNC

Use the WiFi build of FluidNC (not Bluetooth).

**Web installer (easiest).** Open <https://installer.fluidnc.com> in Chrome or Edge,
plug the ESP32 in by USB, and install the latest release (v4.1.1 or newer), WiFi
version. The installer includes a terminal you can use for the commands
below.

**Release bundle.** Download the bundle for your OS from
<https://github.com/bdring/FluidNC/releases>, unzip it and run the WiFi installer
script in it (for example `sh install-wifi.sh` on macOS/Linux). The bundle also contains
`fluidterm`, a serial terminal for FluidNC (115200 baud).

After flashing, open a serial terminal. On boot FluidNC prints its startup log. `$SS`
prints it again at any time.

## WiFi and hostname

FluidNC stores WiFi settings in flash, separately from `config.yaml`. Set them once
over serial:

```
$Sta/SSID=YOUR_WIFI_NAME
$Sta/Password=YOUR_WIFI_PASSWORD
$Hostname=plotter
$WiFi/Mode=STA>AP
$Bye
```

- `$Hostname=plotter` makes the controller answer as `plotter.local`, the app's default
  host.
- `STA>AP` is FluidNC's default mode: it joins your network, and if that fails it starts
  its own access point called `FluidNC` (password `12345678`) at `192.168.0.1`.
  Use `$WiFi/Mode=STA` to disable the fallback.
- `$Bye` restarts the controller. The boot log shows the IP address it got.

## Uploading config.yaml

Edit `config.yaml` first if anything differs from the defaults (currents, travel, pins).
The file must be named `config.yaml` on the controller.

- **Over WiFi.** Open `http://plotter.local/` (or the IP address, or `http://192.168.0.1/`
  on the fallback access point). In the WebUI's flash file panel, upload `config.yaml`.
- **Over USB with fluidterm.** Press Ctrl+U, pick the file, and keep `config.yaml` as
  the destination name.

Then restart with `$Bye`. In the boot log, look for:

- no lines marked `[MSG:ERR: ...]`,
- `X driver test passed` and `Y driver test passed` (the UART link to each TMC2209 works),
- `Axis X (...)` lines showing a range of about 0 to 400 for X and Y and 0 to 5 for Z
  (FluidNC adds one step of slack at each end).

`$CD` prints the config the controller is actually running.

### If a driver test fails

`driver test failed. Check connection` or `TMC driver not detected` means the UART link
is not working for that driver. Check the 1 kΩ resistor, the PDN_UART jumper on the
module, VIO at 3.3 V, the MS1/MS2 address, and the common ground. `Check motor power`
means VM has no 12 V.

Until the UART works, the driver runs in standalone mode: its current comes from the
Vref potentiometer and its microstepping from MS1/MS2. With this address strapping
that gives X 8 microsteps (it moves twice as far as commanded) and Y 32 microsteps
(half as far). If distances are exactly 2× or ½×, suspect the UART.

## Setting motor current

### Does the potentiometer matter?

**No, not once the UART works.** FluidNC's TMC2209 driver writes `I_scale_analog = 0`
to the chip (`tmc2209->I_scale_analog(false)` in `FluidNC/src/Motors/TMC2209Driver.cpp`),
so the driver ignores the Vref pin and uses the internal reference. The current is then
set only by `run_amps` and `hold_amps` in `config.yaml`, together with `r_sense_ohms`.
The onboard potentiometer has no effect.

It does matter if the UART link fails, because the driver then falls back to Vref
(see the previous section). Setting the pot to a safe value, as described in the
fallback below, is cheap insurance.

### Find the motor's rating

1. **Model number.** Look for a label on the motor body, for example `17HS4401`. Search
   for the model plus "datasheet". The rated current is given per phase in amps, for
   example 17HS4401 is commonly listed at 1.7 A. Different sellers reuse model
   numbers, so prefer the seller's or maker's own sheet.
2. **Coil resistance, as a rough guide.** Unplug the motor. Short the multimeter
   leads and note the reading, then measure across one coil pair and subtract it.
   Lower resistance usually means a higher rated current:

   | Coil resistance | Typical rated current |
   | --------------- | --------------------- |
   | under ~2 Ω | 1.5 A or more |
   | ~2 to 4 Ω | about 1 to 1.5 A |
   | over ~5 Ω | often under 1 A |

   This is only an indicator. Treat it as an upper bound, not a target.

The config comment says to set `run_amps` to about **70% of the motor's rated
current**. A 1.7 A motor would get about 1.2 A. A plotter rarely needs that much.

### Tune it

`config.yaml` ships with `run_amps: 0.6` and `hold_amps: 0.3` on both axes. 0.6 A RMS is
safe for most NEMA 17s and usually enough to move a pen carriage and a light tray. A few
small or high-resistance NEMA 17s are rated below 0.85 A. If yours is, start at 70% of
its rating instead.

1. Start at 0.6 A. Jog each axis at working speed: `$J=G91 G21 X100 F6000`, then
   `$J=G91 G21 X-100 F6000` (same for Y).
2. Check for skipped steps: mark the carriage's position, run a back-and-forth jog
   several times, and see whether it lands on the mark. A skip often sounds like a
   clunk or a buzz. Also run a real drawing and check that it closes up.
3. If it skips, raise `run_amps` by 0.1 A on that axis, upload, `$Bye`, and repeat.
   Stop at about 70% of the rated current. If it still skips there, lower
   `max_rate_mm_per_min` or `acceleration_mm_per_sec2` instead, or look for mechanical
   binding.
4. Check temperature after 10 minutes of drawing. Warm is fine, and so is hot as long
   as you can keep a finger on it for a few seconds. If you can't, lower the current. The drivers should not be too hot to touch either. Add a
   heatsink or a fan if they are.
5. `hold_amps` can stay at about half of `run_amps`.

### Fallback: setting Vref (standalone or non-UART use)

Only needed if you run a driver without the UART, or want the pot set to a safe value
in case the UART link fails.

1. **Check the sense resistor.** Next to the motor pins there are two small resistors.
   They are marked with their value: `R110` is 0.11 Ω, `R100` is 0.10 Ω, `R150` is
   0.15 Ω. Most TMC2209 modules use 0.11 Ω. If yours differ, also change
   `r_sense_ohms` in `config.yaml`.
2. **Pick the current.** For 0.11 Ω sense resistors:

   **Vref = I_rms × 1.41**

   So 0.6 A needs Vref ≈ 0.85 V, and 0.8 A needs about 1.13 V. For other sense
   resistors, Vref = I_rms × 1.41 × 2.5 × (R_sense + 0.02) / 0.325.
3. **Measure.** Power the driver with 12 V on VM and 3.3 V on VIO, with no motor
   connected or the motor idle. Put the multimeter's black probe on GND and the red
   probe on the potentiometer's metal top (or the Vref pad if the module has one).
4. **Adjust.** Turn the pot in small steps with a ceramic or plastic screwdriver and
   re-measure. A metal screwdriver can short the pot to nearby pins.

## First power-on checklist

Do these in order, with no pen in the holder.

1. **Power check, no ESP32 or drivers fitted.** Turn on the 12 V supply and measure
   the buck converter output. Set it to 5.0 V. Turn off.
2. **Wire everything with the power off.** Motors connected, capacitors in place.
3. **Place the axes.** FluidNC calls wherever the machine is at power-on X0 Y0 (there
   are no limit switches), and soft limits count 0 to 400 mm from there. With the power
   off, slowly move the pen carriage and the tray by hand so the pen sits over the
   paper's X0 Y0 corner. That is the bottom-left corner in the app by default
   (Settings: origin corner).
4. **Power on and connect.** Turn on 12 V, then check the boot log over USB (`$SS`) for
   errors and the two "driver test passed" lines. Run `$H` once. It only "homes" the
   servo, which lifts the pen to Z5.
5. **Jog X a short way.** `$J=G91 G21 X10 F1000`. The pen should move 10 mm toward the
   right edge of the drawing (+X). If it moved the other way, change X's direction pin
   in `config.yaml` from `gpio.26` to `gpio.26:low`, upload, `$Bye`. (Or, with the power
   off, swap the two wires of one coil.) Jog back with `X-10`.
6. **Jog Y a short way.** `$J=G91 G21 Y10 F1000`. +Y must move the pen 10 mm **toward the
   top edge of the drawing, relative to the paper**. Because Y moves the tray, not the
   pen, the tray itself moves the opposite way: toward the bottom edge. If it is wrong,
   use `gpio.32:low` for Y's direction pin.
7. **Check distance (steps/mm).** Mark the carriage, jog `X100`, and measure with a
   ruler. It should be 100 mm. Small errors come from belt tension or pulley size: set
   `steps_per_mm = 80 × 100 / measured`. An error of exactly 2× or ½× means the UART
   is not working (see [If a driver test fails](#if-a-driver-test-fails)). Repeat for Y.
8. **Set the servo.** With the pen still out, run `G0 Z0` (pen down) and `G0 Z5` (pen
   up), or use the app's Pen down / Pen up buttons. Trim the pulse lengths live:
   ```
   $/axes/z/motor0/rc_servo/min_pulse_us=1100     pen-down position (Z0)
   $/axes/z/motor0/rc_servo/max_pulse_us=1600     pen-up position (Z5)
   ```
   The servo follows the new value immediately. Change in steps of 50 and stay within
   500 to 2500. If Z5 lowers the pen, swap the two values. If the servo buzzes at one
   end, it is pressing on a stop: back off by 50. Live changes are lost at restart,
   so copy the final numbers into `config.yaml` and upload it.
9. **Fit the pen.** At Z0 (down), set the pen so it just touches the paper with light
   pressure. At Z5 (up), it should clear the paper by a few millimetres.
10. **Connect the app.** In the app's Settings, Host `plotter.local` (or the IP), port
    `80`, path `/`. Draw a small square near the origin and send it.

After a soft reset from the app's Stop button, positions are kept. After a power cycle,
repeat step 3 before drawing.

## Adding limit switches later

The config has no switches, so homing is off for X and Y. The `homing:` sections that
are there only set the soft-limit range to 0 to 400 mm. To home against switches at the
X0 and Y0 ends:

1. Wire each switch to an input pin. GPIO34 and GPIO35 are input-only and ideal, but
   have no internal pull-up: add a 10 kΩ to 3.3 V. GPIO4 or GPIO13 can use the internal
   pull-up instead (`:pu`).
2. Under each axis's `motor0:`, add for example `limit_neg_pin: gpio.34:low` (`:low` for
   a normally-open switch to GND).
3. In each axis's `homing:` set `cycle: 2`, `allow_single_axis: true`, and add
   `seek_mm_per_min` and `feed_mm_per_min` (for example 1500 and 200). Z stays on cycle
   1, so `$H` lifts the pen first, then homes X and Y together.
4. Optionally set `must_home: true` under `start:` so the controller stays locked until
   it has been homed.

The comments in `config.yaml` show the same steps at each axis.

## Checking the config

FluidNC ships a schema validator. From a FluidNC source checkout at the matching
release:

```sh
git clone --branch v4.1.1 --depth 1 https://github.com/bdring/FluidNC.git
python3 FluidNC/tools/validate_fluidnc_config.py firmware/config.yaml \
  --schema FluidNC/FluidNC/docs/config_items.yaml
```

It needs `pyyaml` and `jsonschema`. It installs them itself unless you pass
`--no-auto-install`, so use a virtual environment. It checks key names, types, ranges
and enum values, but not whether a GPIO exists on your board.

## Assumptions

- **Board.** An ESP-WROOM-32 (not WROVER: on WROVER boards GPIO16 and GPIO17 are wired
  to PSRAM and cannot be used for the UART). Pin labels and header layout differ
  between 30-pin and 38-pin boards and between makers, so check every GPIO against your
  board's pinout.
- **Drivers.** Generic StepStick-format TMC2209 modules with 0.11 Ω sense resistors and
  an active-low EN pin. Check `r_sense_ohms` against your module.
- **Motors.** 1.8° (200 steps/rev) NEMA 17s. The rated current is unknown, so both
  axes start at 0.6 A RMS.
- **Mechanics.** GT2 belts on 20-tooth pulleys directly on the motor shafts, no
  gearing. About 400 mm of travel on each axis. Change `max_travel_mm` to match your
  frame.
- **Speeds.** 6000 mm/min maximum on both axes (G0 travel runs at this, and it matches
  the app's default travel feed). Acceleration 300 mm/s² on X and 200 mm/s² on Y. These
  are conservative starting points. Tune them on the machine.
- **Pen lift.** The servo swings about 45° (1000 to 1500 µs) between down and up. Your
  pen holder will need its own values (checklist step 8).
- **Position.** Without switches, X0 Y0 is wherever the machine is at power-on.
- **Motors stay enabled.** `idle_ms: 255` keeps the steppers energised at `hold_amps`
  between moves, so the axes can't be pushed out of position. Motors get warm at rest.
  Set a delay in milliseconds instead if you'd rather they switch off when idle.
