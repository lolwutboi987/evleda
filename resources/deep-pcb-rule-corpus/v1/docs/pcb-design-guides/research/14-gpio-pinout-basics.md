# Evidence dossier: GPIO pinout basics, made design-reviewable

**Research date:** 2026-09-06  
**Audience:** PCB designers, embedded developers, reviewers, and AI agents who must turn a pinout drawing into a safe, buildable hardware and firmware interface.  
**Scope:** This dossier retains the useful beginner ideas in JLCPCB's *GPIO Pinout Basics: A Guide for Beginners*, then turns them into a component-specific design and review workflow. It covers MCU and SBC GPIO at a PCB or connector boundary. It is not a substitute for the exact device datasheet, reference manual, errata, board schematic, interface-control document (ICD), or safety/EMC assessment.

**Evidence key:** **High** means a manufacturer datasheet/reference manual directly supports the device-specific statement. **Medium** means established engineering practice that needs project-specific calculation or validation. **Low** means convention or a source that should only be used as orientation. “Example” values below belong only to the cited example device; they are deliberately **not** universal GPIO ratings.

## Direct conclusion

A GPIO pinout is not just a list of header positions or a software API. It is an **electrical, reset-state, multiplexing, power-domain, and firmware contract**. Before assigning a pin, verify at least all of the following for the *exact package and silicon revision*:

1. package ball/pin number, board/header position, net name, and firmware identifier;
2. pin function availability and mux selection, including simultaneous peripheral conflicts;
3. normal, reset, boot, low-power, debug, and unpowered-domain states;
4. logic thresholds, allowed voltage range, injection/back-power behavior, pull direction/value, and output `V_OH`/`V_OL` at the required current;
5. individual, bank, supply-pin, and total source/sink/injection limits; and
6. external circuitry: pulls, series resistor, protection, level translation, load driver, connector protection, and test/debug access.

The JLCPCB article correctly introduces inputs, outputs, PWM, analog use, pull resistors, 3.3 V versus 5 V compatibility, and board-specific numbering. Those are a valuable beginning. They do **not** establish that every GPIO has the same electrical behavior, that an “analog pin” accepts arbitrary voltages, that a 5 V signal is safe, that internal pulls are sufficient, or that an output-current headline is a design target. The governing answer is always the current documentation for the selected MCU/package and the connected device.

## What the required article contributes, and its boundary

The required JLCPCB article, [*GPIO Pinout Basics: A Guide for Beginners* (JLCPCB, published 2025-04-10; updated 2026-08-22)](https://jlcpcb.com/blog/critical-role-of-gpio-pinouts-selection-in-embedded-systems), describes GPIO as the bridge between controller code and external hardware. It introduces input, output, PWM, and analog use; warns that floating inputs need a defined state; calls out voltage compatibility and level shifting; and distinguishes physical/header numbering from the chip's Broadcom-style numbering in the Raspberry Pi example. These are sensible **Medium**-confidence orientation points.

Retain these lessons:

- A GPIO is programmable and can connect a controller to sensors, LEDs, controls, motors, and communications functions.
- A pin label in software must be mapped to the correct physical/header position and IC package pin.
- An input requires a valid logic-level source or intentional bias; a bare switch and a nominally unused trace can leave it indeterminate.
- External voltage compatibility must be checked before connection; a translation circuit may be necessary.
- PWM is a timed digital waveform, not an analog output by itself. An ADC-capable pin is not automatically a DAC-capable or 5 V-tolerant pin.

Do **not** retain these as blanket rules: “four GPIO types,” “all Arduino analog pins can read any voltage,” “all Raspberry Pi GPIOs are 3.3 V safe,” or “a level mismatch is the number-one cause of damage.” The article is an educational fabrication-vendor post, not a device electrical specification. At the time of research, the URL in the request redirected to the JLCPCB article above; treat the title/URL mapping as publisher-managed rather than a stable technical identifier.

## Definitions that prevent pinout mistakes

| Term | Meaning in this dossier | Review consequence |
|---|---|---|
| GPIO | A pad whose digital input, digital output, alternate peripheral, and sometimes analog paths can be selected/configured. | “GPIO” does not promise every mode or feature on every pin. |
| Pinout | The mapping among package pad number, signal name, electrical type/domain, reset behavior, board net, connector/header position, and firmware pin identifier. | A header diagram alone is incomplete. |
| Input threshold | The guaranteed voltage range interpreted low (`V_IL`) or high (`V_IH`) under stated supply/temperature conditions. | A nominal 3.3 V or 5 V label is not enough to prove interoperability. |
| `V_OH` / `V_OL` | Guaranteed output-high minimum / output-low maximum at a stated source or sink current. | Output drive must be checked at the actual load current, not only an “mA drive” setting. |
| Push-pull | Output actively drives both low and high with NMOS/PMOS devices. | Two enabled push-pull sources on one net can fight and be damaged. |
| Open-drain/open-collector | Output actively pulls only one direction, normally low; a resistor or other device establishes high. | It needs an intentional pull-up, rise-time calculation, and voltage-domain check. |
| Pull-up/pull-down | A resistor that supplies a weak default logic level. It can be internal, external, or both. | Its resistance, tolerance, reset availability, and interaction with other drivers matter. |
| Alternate function / mux | A selection that routes a pad to a peripheral such as UART, SPI, I2C, timer, ADC, or debug. | Two desired functions may be mutually exclusive even when each appears in a pin table. |
| 5 V tolerant | A **specific documented input condition**, often with exclusions. It does not mean 5 V output, 5 V analog range, or safe operation while all supplies are off. | Check the exact pad type, mode, supply condition, and internal-pull/protection-diode restrictions. |
| Injection/back-power | Current forced through a pad's protection path when a voltage exceeds a rail or a rail is unpowered. | It can corrupt operation or damage a device even below an informal “seems to work” voltage. |

## The pin is a circuit, not a Boolean variable

A useful generic mental model is below. The exact elements and their availability vary by device and pin.

```text
                         selected peripheral input / GPIO input register
                                             ^
external net -- ESD/clamp --+-- input buffer / Schmitt / analog switch
                             |
                         optional weak pull-up or pull-down
                             |
                     output mux --> PMOS high-side (push-pull only)
                                  --> NMOS low-side (push-pull/open-drain)
```

For example, TI's MSPM0G350x I/O diagram exposes a peripheral mux, input path, output path, wake logic, programmable pulls and drive control, and analog connection, but explicitly says not all pins have all functions. Its special 5 V-tolerant open-drain pads omit the high-side PMOS, internal pull-up, and clamp diode. [TI's MSPM0G350x datasheet](https://www.ti.com/lit/ds/symlink/mspm0g3507.pdf) is **High** evidence for that family, and strong evidence for why a generic “GPIO” label hides material differences; it is not a template for a different MCU.

### Logic input is an analog requirement with a digital interpretation

The valid high and low regions are guaranteed regions, with an undefined zone between them. A robust interface must deliver a voltage inside `V_IL(max)` for low or above `V_IH(min)` for high under supply, temperature, cable/drop, leakage, and noise conditions. Do not design to a typical switching point. A hysteretic/Schmitt input is more noise-tolerant during a slow edge, but it does not make arbitrary voltages, ringing, or prolonged threshold dwell safe.

Input thresholds vary dramatically. An ATmega328P datasheet plots both I/O and reset thresholds against `V_CC` and temperature; it does not justify a fixed threshold inferred from a 3.3 V or 5 V board label. [ATmega328P datasheet, section 29.1.5](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf) is an illustrative **High** primary source. For the actual MCU, record the guaranteed table entries, not a graph read by eye.

**Input design checks:**

- Verify voltage limits separately from logic thresholds. A voltage can be interpreted high yet exceed the pin's permitted input or injection limit.
- Include the driver `V_OH(min)`/`V_OL(max)`, receiver `V_IH(min)`/`V_IL(max)`, ground difference, and cable/transient margins in one interface table.
- Account for leakage, switch contact condition, sensor output type, ADC sampling load, pull resistance, and capacitance. A high-value pull may be fine for a button and too slow for I2C or a fast wake signal.
- Disable or select the digital-input buffer as the selected MCU's analog/low-power guidance requires. An enabled digital path can add leakage/noise or power use; an analog-capable package pin may still have a separate analog range.

### Output current and drive are constraints, not a load-driver specification

An output “12 mA” setting can mean a nominal pad-drive selection, a test current, or an absolute maximum depending on the vendor. It is not a promise that every pin can permanently power a 12 mA load at compliant logic voltage. Check output voltage tables/curves, thermal/current aggregation, and supply routing.

The RP2040 provides an instructive, bounded example: its pad controls offer 2, 4, 8, or 12 mA drive selections, and its datasheet explains that greater source current lowers the output-high voltage; it defines `V_OH` at a selected drive/current condition. It also specifies total current limits associated with the I/O supply and ground. [RP2040 datasheet, GPIO pad controls and pinout electrical characteristics](https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf) is **High** for RP2040 only. The correct conclusion is not “all GPIOs are 12 mA,” but “choose the output specification that preserves receiver margins and stays inside all aggregation limits.”

An STM32H743 example demonstrates why a single-pin number is incomplete: the cited datasheet lists a 20 mA maximum sink current for many I/O/control pins, a 1 mA maximum for another pin class, 140 mA aggregate source and sink limits across I/Os/control pins, 100 mA limits per power/ground pin, and other supply totals. It also calls for current to be distributed across power pins rather than concentrated between adjacent supply pins. [STM32H743 datasheet DS12110, electrical characteristics](https://www.st.com/resource/en/datasheet/stm32h743vg.pdf) is **High** evidence for that exact variant/revision family; these values are neither a recommended design current nor portable to another STM32/package.

Use a transistor, gate driver, LED driver, load switch, or dedicated buffer when the GPIO would otherwise carry a load that threatens logic margin, total current, startup behavior, fault tolerance, or EMC. A low-side MOSFET with a gate resistor/pull is a common pattern for a load; it is not interchangeable with direct GPIO drive. Provide flyback control for inductive loads and size it from the load's actual switching and energy conditions.

## Pull resistors: deterministic state requires a calculation

An internal pull is useful for a local, low-speed, low-noise default state, but its value can be broad, temperature/process dependent, unavailable in a boot mode, or disabled by an alternate/analog configuration. Treat it as a documented device feature, not an external component replacement by default.

For a pull-up `R_PU` and capacitance `C_BUS`, the ideal RC 10%-to-90% rise-time approximation is `t_r ≈ 2.2 R_PU C_BUS`. For a wired-AND bus, `R_PU` must be **low enough** for the required rising edge and **high enough** that every device can sink the low-state current `V_PULLUP / R_PU` while meeting `V_OL`. Leakage, external protectors, cable capacitance, and parallel pulls change both calculations.

```text
3V3
 |
R_PU (value justified by rise time and sink capability)
 +------ MCU SDA / peripheral SDA / connector
 |
open-drain devices can pull low; no device actively drives high
```

For a simple active-low switch, a separate external pull has additional benefits: it works before firmware executes, is visible in the schematic/BOM, and can be selected for EMC/current behavior. For a power-sensitive product, an external pull consumes static current whenever asserted, so it must be included in the power budget. Do not install both internal pull-up and pull-down unless the exact MCU documents the resulting behavior and the circuit needs it.

## Push-pull, open-drain, and shared nets

| Topology | Safe use | Main hazards / required review |
|---|---|---|
| Push-pull GPIO to one CMOS input | Fast, low-capacitance point-to-point control at compatible levels. | Verify `V_OH/V_OL`, edge rate/EMI, reset state, and no other enabled driver. |
| Open-drain plus one pull-up | I2C, shared interrupt, fault/alarm, wired-AND signaling, or limited high-domain translation. | Check external pull-up, rise time, every device's pin-voltage tolerance, sink current, and power-off behavior. |
| Multiple push-pull drivers | Only when an explicit bus-arbitration/tri-state protocol guarantees one driver at a time. | Contention during reset, firmware fault, or mux change can create damaging current. |
| GPIO through a buffer/transceiver | Long cable, heavy capacitance, translation, isolation, or fault containment. | Select direction/default enable, failsafe behavior, supply-off tolerance, and protection. |

On TI's MSPM0G350x, the documented 5 V-tolerant open-drain pads need an external pull-up for high output, can tolerate an applied voltage when `VDD` is absent, and omit the normal high-side/clamp/pull circuitry. That is an example of a **qualified** 5 V-tolerance feature, not license to place a 5 V pull-up on arbitrary MCU pins. The exact source calls these ODIO pads fail-safe; no analogous claim may be copied to a standard pin without that device's documentation.

## Voltage compatibility, 5 V tolerance, and level shifting

The safe question is not “is it a 3.3 V board or a 5 V device?” It is: **at every state, what voltage/current reaches this exact pad while its related supplies and configuration have these states?** Make a state table that includes normal operation, reset, programming, power sequencing, brownout, and one side unpowered.

| Situation | What must be verified | A common wrong shortcut |
|---|---|---|
| 3.3 V driver to 3.3 V receiver | Driver `V_OH/V_OL` versus receiver thresholds and shared-ground noise. | “Both say 3.3 V.” |
| 3.3 V receiver connected to a 5 V output | Input maximum, injection current, pad type, and reset/power-off behavior. | “It reads high, so it is safe.” |
| Open-drain bus pulled to 5 V | Every attached pin's open-drain/fail-safe rating; no hidden internal pull or upper clamp; sink current and rise time. | “Open drain always translates levels.” |
| Direction-changing line | Contention and enable timing during reset/fault; translator default direction. | “The firmware changes direction fast enough.” |
| Analog source | ADC absolute input range, reference/analog supply, source impedance/acquisition time, clamp/injection, and digital-path configuration. | “ADC pin means any 0–5 V signal can be measured.” |

The STM32H743 datasheet makes the qualification concrete: it distinguishes FT/TT pad types and says that, for its cited operating conditions, internal pulls must be disabled to sustain a voltage above 4 V; an FT-a pin used by an analog peripheral has a lower listed maximum input condition. That single family is enough to disprove the universal claim that “5 V-tolerant” applies across modes. Use the exact pin-definition/electrical tables for the chosen part.

Use a resistor divider only where the signal direction, input impedance/leakage, bandwidth, clamp behavior, transient energy, and unpowered behavior make it valid. A divider does not translate a bidirectional bus. For I2C, a suitable bidirectional open-drain translator or a device rated for both sides is often appropriate, but its capacitance, pull-up arrangement, low-level offset, speed, and power-up behavior need review. For SPI/UART/control, choose an explicitly rated unidirectional or direction-controlled buffer/translator. Series resistance may limit injection/transient current, but it does not itself make an over-voltage condition compliant; calculate against the datasheet's injection specification and transient source.

## Modes: GPIO, alternate function, analog, and low power

The term “GPIO pin” frequently hides three independent controls: function mux, input-enable/analog switch, and output type/enable. Peripheral setup code can therefore silently override a prior GPIO configuration, or a later GPIO initialization can disconnect a peripheral.

ST's RM0433 is a useful primary example: each STM32H743 port bit can be configured as floating/pulled input, analog, push-pull/open-drain output, or push-pull/open-drain alternate function; separate registers control mode, type, speed, pulls, and alternate-function selection. It also documents atomic set/reset registers, avoiding a read-modify-write race for output bits. [RM0433, GPIO chapter](https://www.st.com/resource/en/reference_manual/rm0433-stm32h742-stm32h743753-and-stm32h750-value-line-advanced-armbased-32bit-mcus-stmicroelectronics.pdf) is **High** for STM32H743/related devices and not a register model for all MCUs.

**Mux review procedure:**

1. Start with the exact package's alternate-function table and board pinout; package options can omit pads or alter available functions.
2. Allocate peripheral instances and signals before routing. A desired UART, SPI, ADC channel, timer/PWM, debug port, oscillator, and boot strap may compete for the same pads.
3. Build one machine-readable pin matrix with one row per package pad and columns for reset, boot, normal, sleep, alternate function, electrical type, board net, connector position, and firmware symbol.
4. Verify every supported product variant and optional population. A DNP sensor or alternate connector can release a function, but do not silently rely on it.
5. Compile/build firmware using the intended pin configuration and inspect peripheral-mux registers or generated configuration. A schematic-only review cannot discover an incorrect SDK board definition.

Analog mode deserves its own review. On RP2040, the ADC input range is specified from 0 to `ADC_AVDD`, with a stated input impedance; GPIO/ADC functions share only particular pins. That does not mean all digital GPIO or header positions can measure analog voltage. The current [RP2040 datasheet](https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf) also separates the digital I/O supply (`IOVDD`) from the ADC supply/analog role, illustrating why “the chip runs at 3.3 V” is insufficient.

## Boot, strap, reset, clock, debug, and programming pins

Treat these as **reserved until deliberately released**, even when the mux table says GPIO is possible:

- **Boot/strap pins:** their level is sampled at a particular reset/power event. A connected peripheral, LED, pull, or external programmer can select the wrong boot path. Preserve the documented resistor direction/value and avoid loads that distort it before the sample point.
- **Reset/enable:** reset pins can have special thresholds, pull requirements, filtering, and debug-probe interaction. A reset line shared with an external device needs a state table and access plan, not a casual GPIO allocation.
- **Debug/programming:** reserve SWD/JTAG/UPDI/ISP/UART/USB bootstrap paths plus ground and a suitable reference/target-voltage sense where the tool expects it. A production board without a recovery path needs a documented, accepted risk.
- **Clock/crystal/flash:** oscillator pins are analog/clock circuitry; execute-in-place flash pins may become fatal if repurposed. Their availability cannot be inferred from “GPIO.”
- **Test and factory pins:** follow vendor tie-off instructions exactly. Do not use an unverified factory/test pad as a user control.

RP2040 provides a compact example: its `RUN` pin is a global asynchronous reset, `SWCLK`/`SWDIO` are debug access pins, `TESTEN` must be tied to ground, and the QSPI pins service the external execute-in-place flash although the datasheet notes they can be software GPIO only when flash access is not required. It also says the USB bootloader requires a 12 MHz crystal/clock. These are **High** RP2040-specific constraints from the datasheet, not an implication that every MCU uses the same boot or debug pins.

TI's MSPM0G350x basic schematic provides another primary example: `NRST` must be pulled to `VDD` for startup, and TI depicts SWDIO/SWCLK debug access. The 47 kOhm/10 nF network shown is an example/reference arrangement, not a generic reset recipe. A reset capacitor can interfere with a programmer or supervisor if copied without timing review.

## Power domains, state transitions, and unused pins

Every GPIO row should identify its pad domain and the external device's domain. A device can have separate core, digital-I/O, analog, USB, backup, and transceiver rails. When one domain is off, an input protection structure may source it through an external GPIO. That can cause partial power-up, undefined reset, excess injection current, or a system that only fails during power sequencing.

RP2040's pinout tables label normal GPIO, QSPI, SWD, and `RUN` as `IOVDD`-domain functions, while USB pins use `USB_VDD` and ADC behavior is separately specified. This is an example of why a board's power-tree drawing must be reviewed together with its pinout, not after it.

For **unused pins**, use the exact vendor recommendation. Possible correct treatments include leaving a listed `NC` physically unconnected, configuring an unused GPIO to analog/disabled input, assigning a documented pull, or tying a special pin as instructed. They are not interchangeable. Never tie a true “do not connect,” a test pad, analog reference, or a supply/reserved pin based on a generic unused-GPIO rule. Record the reset state even if firmware later configures a low-power state.

For low-power modes, verify whether GPIO configuration, pulls, wake detectors, and pad retention remain active. The TI I/O diagram, for example, includes shutdown wake logic and retention-related behavior; its precise implementation must be checked in the family technical reference manual. A floating connector input can become a wake source or leakage path when the firmware's normal pull configuration is absent.

## Protection, ESD, EMC, and series resistance at a connector

On-board point-to-point GPIO may need only signal-integrity/EMC consideration; a user-accessible or cable-connected GPIO is an I/O protection boundary. Identify the applicable threat: ESD handling, EFT/surge, miswire, long-cable ringing, ground potential difference, RF ingress, hot plugging, and exposure while unpowered. Product safety and compliance requirements may prescribe tests or components beyond this guide.

Typical connector-side pattern, to be engineered rather than copied:

```text
connector -- protection device -- optional series R/common-mode element -- MCU/translator
                              |                                      |
                            chassis/return                     local pull / clamp path
```

Select a protector by working voltage, clamping behavior at the relevant waveform/current, capacitance, leakage, dynamic resistance, package/return inductance, and its connection to the chosen return. A generic TVS data-sheet “clamp voltage” does not prove the downstream MCU pin is below its absolute maximum. Place protection and its return path so the high-current transient loop does not traverse the protected interior.

A series resistor can reduce edge rate, ringing, EMI, inrush into a clamp, and fault/injection current. Its value is an interface calculation: include output impedance, receiver capacitance, required rise/fall time, cable impedance, pulse energy, and vendor injection limits. It can degrade fast SPI/clock signals or form an excessive source impedance for an ADC. Do not put a large “ESD resistor” on a line merely because it is named GPIO.

RP2040 is a useful example of a requirement that must remain device-specific: its USB `DP` and `DM` pins require 27 Ohm series termination resistors. That is a USB PHY requirement, not a rule to add 27 Ohm to arbitrary GPIO lines. The same datasheet's required-resistor language is a reminder to transfer per-pin reference circuitry into the schematic and layout review.

## Interrupts, edge quality, and asynchronous reality

An interrupt-capable GPIO still sees an asynchronous external signal unless it is derived from the MCU clock domain. Verify which pins support the required interrupt/wake source, whether the peripheral captures level/rising/falling/both edges, and what occurs if an edge arrives during masking, sleep entry, reset, or mux transition.

- Mechanical switches need debouncing in hardware, firmware, or both. An interrupt can observe multiple legitimate contact transitions.
- Slow/noisy edges can cross the threshold repeatedly; use a documented Schmitt input, external hysteresis/filter, and/or digital qualification appropriate to latency requirements.
- A short pulse can be missed if it is below the receiver's synchronization/filter/capture requirement. Use an external latch, timer capture, asynchronous peripheral, or pulse stretching if needed.
- Clear an interrupt pending flag in the documented order and design the handler around the source's level/edge semantics. Firmware can otherwise loop forever on an asserted level source.
- For an externally accessible interrupt, include pull state, protection capacitance/leakage, ESD recovery, cable behavior, and the remote device's power-off behavior.

The exact interrupt routing and metastability handling are MCU-specific. Do not claim that a pin supports an interrupt merely because it is GPIO; prove it with the device reference manual and the selected package/pad matrix.

## Pin mapping and firmware consistency

A successful PCB can still be nonfunctional if the names in the schematic, PCB, connector drawing, documentation, and firmware describe different pins. Make pin mapping a controlled artifact rather than a collection of comments.

Recommended fields for a `pinmap.csv` or generated board-description table:

| Field | Example purpose |
|---|---|
| MCU manufacturer part/package/revision | Identifies the authoritative pin table. |
| Package pad / die pin name | `PA9`, `GPIO17`, ball `B4`, etc.; do not substitute header number. |
| PCB net and connector/header position | Makes electrical tracing unambiguous. |
| Firmware symbol and SDK identifier | `PIN_SENSOR_INT`, `GPIO17`, HAL port/pin, device-tree line. |
| Reset/boot/sleep state | Prevents a firmware-only assumption from hiding a hardware state. |
| Intended mux, direction, output type, pull, drive/slew | Captures the selected configuration. |
| Domain and electrical limits | Links threshold, voltage, injection, and current constraints. |
| External circuit and interface owner | Pull, translator, ESD, series resistor, mate, cable, or load. |
| Verification | Datasheet table/revision, schematic sheet/location, test case, reviewer. |

Use semantic firmware names (`PIN_MOTOR_FAULT_N`) instead of opaque bare numbers in application code. Generate or compare the mapping from a single source where practical, but independently inspect the final netlist and compiled pin configuration. A CI check can parse the schematic/netlist and compare it with firmware board definitions; it cannot infer that the selected analog channel, boot strap, or high-current LED load is electrically appropriate.

## Worked examples

### Example A — Button plus wake interrupt

```text
3V3 -- R1 external pull-up --+-- MCU_WAKE_N
                            |
                         SW1 to GND
```

Before release, confirm the MCU pin's reset state and wake capability, R1's tolerance/current, switch/cable placement, debounce strategy, and whether a programmer/debugger also uses the pin. If the internal pull is used instead, document its specified range and low-power/reset availability; do not label the resulting behavior “fixed” without those facts. At the connector, add a protection/filter strategy justified for exposure and wake latency.

### Example B — 3.3 V MCU reads a 5 V open-drain alarm

```text
5V -- R_REMOTE -- ALARM_N ---- transistor/open-drain remote device
                         |
                  translator or MCU ODIO only if exact pad documentation permits it
                         |
                       3V3 MCU input
```

First choice is often to pull the open-drain alarm to the MCU's 3.3 V domain if the remote output's ratings and both systems' power states allow it. If the pull must remain at 5 V, select a translator or only an exact documented 5 V-tolerant/fail-safe pad mode. Confirm the whole power-off matrix. Never use a resistor divider on a shared open-drain line unless it has been analyzed for its effect on low level, rise time, thresholds, and remote-side behavior.

### Example C — PWM-controlled fan or motor load

```text
MCU PWM -- Rg -- gate of external MOSFET/driver -- load
              |
             Rpd to a deterministic off state
```

The GPIO does not power the motor. The review must cover the driver/MOSFET gate thresholds at the MCU's real `V_OH`, boot/reset off state, switching loss and gate charge, flyback/recirculation topology, supply/load return path, connector fault, and PWM frequency/edge-rate EMC. If the controller's pin starts pulled high at reset, the added `Rpd` and any mux timing must demonstrably keep the load off.

### Example D — I2C header with optional external sensor

```text
3V3 -- R_SCL --+-- MCU SCL (open-drain mode) -- J1 SCL
3V3 -- R_SDA --+-- MCU SDA (open-drain mode) -- J1 SDA
GND ----------+------------------------------ J1 GND
```

Specify pull-up ownership and population so parallel pulls on modules do not create an unintended low resistance. Calculate bus capacitance and rise time; check each device's maximum `V_OL` sink current and its address/interrupt/reset strap state. If the sensor can be unpowered while the MCU pulls up, assess back-power through every SCL/SDA/interrupt pin. A two-channel bidirectional translator may be required when domains differ, but it introduces its own rise-time and low-level constraints.

## Release workflow and required documents

### Before schematic capture

1. Freeze the exact MCU part number, package, voltage ranges, and documentation revisions. Add errata and pin/package revision to the source set.
2. Obtain the system ICD for every external connection: mating pinout/orientation, voltage, protocol role, cable, maximum length, power sequencing, test environment, and protection/compliance requirement.
3. Build the pin matrix before choosing connectors. Reserve boot, reset, clock, debug, programming, analog reference, external memory, and power pins first.
4. Allocate peripheral instances and document mux conflicts. Re-run allocation when a feature or package changes.

### Required design records

| Record | Minimum contents | Why a pinout image cannot replace it |
|---|---|---|
| Exact datasheet/reference manual/errata set | Revision/date plus relevant electrical, pin-mux, reset, and boot sections. | Electrical limits and default states are device/version-specific. |
| Pin matrix / firmware map | Fields listed above, reviewed against package and board nets. | Connects firmware identifiers to physical reality. |
| Schematic and netlist | Pulls, translators, drivers, protection, series parts, power domains, test points. | Shows the circuit around the pin. |
| PCB and connector drawing | Pin 1/orientation, shield/return, routing/placement/protection constraints. | Prevents mirror and boundary errors. |
| ICD and power-sequencing table | Both ends, normal/reset/off states and maximum ratings. | Finds level mismatch and back-power faults. |
| Firmware configuration and build artifact | Mux/pulls/direction/drive/interrupt setup, board version. | Proves the selected hardware function is actually configured. |
| Verification plan and results | Electrical tests, reset/boot/debug recovery, fault/ESD/EMC tests as applicable. | A schematic and compile do not validate real edges or faults. |

### Hardware/firmware verification gates

1. **Schematic gate:** cross-check every used/reserved pad against the exact datasheet table. Run ERC, inspect no-connects, and trace every connector pin, boot/reset/debug path, pull, level shifter, and load.
2. **PCB gate:** verify package pin 1, footprint, connector mate orientation, protection placement/return, series element placement, and that special routing/reference-layout constraints were transferred.
3. **Firmware gate:** build for the board revision, emit/inspect pin configuration, and test mux collision prevention. Confirm startup ordering leaves outputs safe before enabling loads.
4. **Bring-up gate:** measure rails and pin states during power-up/reset/programming/sleep; validate `V_OH/V_OL` at load, input thresholds/noise margins, rise/fall time, I2C rise time, and aggregate current. Test the recovery/debug route on production-like hardware.
5. **Boundary gate:** test connected and disconnected mate, one-side-unpowered, brownout, expected hot-plug/fault states, and the applicable ESD/EMC/surge plan. Do not claim compliance solely from a TVS footprint or a passed GPIO functional test.

## Instructions for an AI design/review agent

1. Treat a blog pinout, board silk label, SDK alias, online diagram, and symbol library as untrusted discovery input. Do not make release decisions from them.
2. Obtain the exact MCU/package datasheet, reference manual, errata, and connected-device datasheets. Record URL, revision/date, page/table/section used, and whether a source was accessible.
3. Produce a per-pad matrix. Flag any missing package pin number, board net, firmware identifier, reset state, domain, mux, or electrical limit as **unverified**, not as an assumed default.
4. For every input, compare guaranteed driver and receiver limits at the actual conditions. For every output, compare `V_OH/V_OL` at load with individual, aggregate, supply-pin, and thermal limits. Keep absolute maximum separate from operating/recommended conditions.
5. Treat 5 V tolerance as false unless the exact pad/mode/supply condition documents it. Flag analog use, internal pulls, external pull-up voltage, unpowered domains, and clamp/injection limits as separate checks.
6. Detect mux conflicts across peripherals, debug/boot/clock/flash pins, and optional assemblies. A function label is not proof that it can coexist with all others.
7. Trace connector paths through protection, translation, series components, pulls, and return/shield. Require an ICD and a normal/reset/off state table for exposed or off-board connections.
8. Compare schematic, PCB, firmware configuration, test fixture, and documentation mappings. Report mismatches with both identifiers and locations; never silently rename a net or firmware pin.
9. Require explicit treatment for every unused/NC/strap/reset/test pin using the manufacturer wording. Do not convert “NC” into “tie low” or “floating GPIO” by heuristic.
10. Report conclusions as **verified**, **conditional**, or **unknown**. A green ERC, successful compilation, or a pin that toggles on a bench does not prove voltage tolerance, EMC robustness, safety, or production recovery.

## Exceptions and judgment calls

- **Board-level headers:** a Raspberry Pi/Arduino-style header map is a board interface, not necessarily the MCU package pinout. Preserve physical header numbering, board naming, and chip naming in the same table.
- **Internal pulls:** can be appropriate for a local button or a configuration default if their documented range/state works. An external resistor is often preferable for a strap, safety-critical default, long trace, cable, or deterministic pre-firmware state.
- **Reserved pins used as GPIO:** may be acceptable only after the chosen boot mode, external memory, debug/recovery policy, production test, and future firmware plans are explicitly reviewed. “The demo works” is not enough.
- **Analog-capable pads:** may need an analog-mode setting, input-source impedance constraint, quiet routing, reference/ground treatment, and conversion timing. A digital pin list cannot approve analog performance.
- **High-speed signals:** GPIO muxing does not remove protocol routing requirements. USB, clock, QSPI, fast SPI, Ethernet-related signals, and RF controls can require impedance, length, return, termination, and layout guidance beyond GPIO advice.
- **Isolated or hazardous interfaces:** optocouplers, isolators, creepage/clearance, fusing, field grounding, and safety certification are system decisions. Do not replace a safety review with a level-shifter selection.

## Evidence gaps and limits

| Gap | Effect | Required handling |
|---|---|---|
| No target MCU, package, board, firmware, connector, or load was provided. | This dossier cannot name safe resistor values, pin assignments, voltage levels, current budgets, or a compliant protection topology. | Apply the matrix/workflow to the actual design and its current primary documents. |
| JLCPCB provides beginner guidance, not a normative electrical specification. | Its four-category framing and examples can hide mux, reset, power-off, and pad-type exceptions. | Retain only the orientation points; use device sources for release decisions. |
| Datasheets can have variant, package, revision, errata, and mode differences. | A number copied from a sibling device can be unsafe. | Cite the exact ordered device/package/revision and recheck on a change. |
| No system threat model or applicable compliance standard was supplied. | ESD, surge, EMC, cable, and safety claims cannot be made. | Define the environment and test plan before selecting protection. |

## Claim-to-source ledger

| ID | Claim supported | Source and publisher/date | Confidence and scope |
|---|---|---|---|
| G1 | GPIO supports external interface use; inputs, outputs, PWM, analog use, pulls, voltage compatibility, and board numbering are useful introductory concepts. | [*GPIO Pinout Basics: A Guide for Beginners* — JLCPCB, published 2025-04-10; updated 2026-08-22](https://jlcpcb.com/blog/critical-role-of-gpio-pinouts-selection-in-embedded-systems) | Medium. Educational vendor article; not a specification. |
| G2 | MSPM0G350x I/O mux/pad architecture includes selectable input/output/peripheral/analog features; not all pins have all capabilities. Its 5 V-tolerant ODIO pads omit high-side PMOS/internal pull/clamp; external pull-up is required for high. | [*MSPM0G350x Mixed-Signal Microcontrollers With CAN-FD Interface Datasheet*, SLASEX6C Rev. C — Texas Instruments, revised 2025-10](https://www.ti.com/lit/ds/symlink/mspm0g3507.pdf) | High for cited MSPM0G350x device/pad types; not transferable. |
| G3 | STM32H743 GPIO supports distinct input/analog/output/alternate modes, pull and output type selection, and atomic set/reset; its electrical tables demonstrate distinct per-pin, aggregate, supply-pin, and injection constraints plus qualified FT behavior. | [*STM32H742xI/G, STM32H743xI/G Datasheet*, DS12110 Rev. 11 — STMicroelectronics](https://www.st.com/resource/en/datasheet/stm32h743vg.pdf); [*RM0433 Reference Manual* — STMicroelectronics](https://www.st.com/resource/en/reference_manual/rm0433-stm32h742-stm32h743753-and-stm32h750-value-line-advanced-armbased-32bit-mcus-stmicroelectronics.pdf) | High for cited STM32 family/revision; never use its current or voltage values as generic limits. |
| G4 | RP2040 documents separate pad control, drive choices, pulls, slew, `V_OH/V_OL` interpretation, total I/O current constraints, ADC range, domain tables, QSPI/USB/reset/debug/test functions, and USB series resistors. | [*RP2040 Datasheet* — Raspberry Pi, current document accessed 2026-09-06](https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf) | High for RP2040; a deliberate counterexample to universal GPIO assumptions. |
| G5 | Input thresholds and output behavior depend on supply/temperature/current for an MCU family. | [*ATmega328P Datasheet*, section 29.1 — Microchip/Atmel](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf) | High for cited ATmega328P documentation; illustrative only. |
| G6 | Pull-up/rise-time, level shifting, protection, interrupt, pin-mapping, and validation recommendations are engineering synthesis from G1–G5 and require project-specific calculation/testing. | Inference from the primary sources above plus the actual interface/device documentation. | Medium. No generic source can approve a particular PCB connection. |

## Searches performed and stop rationale

Research retrieved the required JLCPCB article and primary documentation from TI, ST, Raspberry Pi, and Microchip. The sources were deliberately chosen to show different pad architectures and to test each consequential beginner claim against manufacturer documentation: configurable mux/modes, conditional 5 V tolerance/open drain, thresholds, output-drive interpretation and aggregation, distinct power domains, reset/debug/flash pins, analog range, and required USB series components. Further broad “GPIO basics” searches would repeat secondary tutorials; all remaining release-critical facts are necessarily target-device, package, board, connected-device, and environment specific.
