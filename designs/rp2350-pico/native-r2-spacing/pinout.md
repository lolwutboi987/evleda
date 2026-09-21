# R2 header pinout

Viewed from the component side, USB at the top. The native board is 22 x 60 mm; GPIO pitch is 2.54 mm and row spacing is 17.78 mm. This table is derived from the saved physical pad positions and net names.

Printed numbers are **GPIO numbers**, not connector pin numbers. `G` means GND, `REF` means ADC_VREF, and `EN` means 3V3_EN. J2/J3 pin numbers below are local to their respective connector.

| Row, top to bottom | Left pin | Left signal | Printed | Printed | Right signal | Right pin |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | J2.1 | GPIO0 | 0 | VBUS | VBUS | J3.20 |
| 2 | J2.2 | GPIO1 | 1 | VSYS | VSYS | J3.19 |
| 3 | J2.3 | GND | G | G | GND | J3.18 |
| 4 | J2.4 | GPIO2 | 2 | EN | 3V3_EN | J3.17 |
| 5 | J2.5 | GPIO3 | 3 | 3V3 | 3V3 | J3.16 |
| 6 | J2.6 | GPIO4 | 4 | REF | ADC_VREF | J3.15 |
| 7 | J2.7 | GPIO5 | 5 | 28 | GPIO28 | J3.14 |
| 8 | J2.8 | GND | G | G | GND | J3.13 |
| 9 | J2.9 | GPIO6 | 6 | 27 | GPIO27 | J3.12 |
| 10 | J2.10 | GPIO7 | 7 | 26 | GPIO26 | J3.11 |
| 11 | J2.11 | GPIO8 | 8 | RUN | RUN | J3.10 |
| 12 | J2.12 | GPIO9 | 9 | 22 | GPIO22 | J3.9 |
| 13 | J2.13 | GND | G | G | GND | J3.8 |
| 14 | J2.14 | GPIO10 | 10 | 21 | GPIO21 | J3.7 |
| 15 | J2.15 | GPIO11 | 11 | 20 | GPIO20 | J3.6 |
| 16 | J2.16 | GPIO12 | 12 | 19 | GPIO19 | J3.5 |
| 17 | J2.17 | GPIO13 | 13 | 18 | GPIO18 | J3.4 |
| 18 | J2.18 | GND | G | G | GND | J3.3 |
| 19 | J2.19 | GPIO14 | 14 | 17 | GPIO17 | J3.2 |
| 20 | J2.20 | GPIO15 | 15 | 16 | GPIO16 | J3.1 |

The bottom SWD connector is **CLK - G - DIO** from left to right: J4.1 SWCLK_HDR, J4.2 GND, J4.3 SWDIO_HDR. BOOT selects boot mode; RESET operates RUN.

Operating values are candidate design targets, not measured board ratings. The retained operating-constraints review defines the shared rail/load budgets and interface limits. In particular, 3V3 is an output and EN is an open-drain disable input pulled toward VSYS.

Source PCB SHA-256: `b5206f5db12ea972b5fd87f2dc0071065363a6816e834cb38522f661472219e1`.
