# 60 mm candidate header pinout

Viewed from the component side with USB at the top. The board is 22 × 60 mm; header pitch is 2.54 mm and row spacing is 17.78 mm. Pin numbers below are local to J2 and J3.

These are saved native net assignments. Routing and electrical qualification remain incomplete; this table does not establish voltage limits or working connections.

| Top-to-bottom row | Left pin | Left signal | Right signal | Right pin |
| --- | --- | --- | --- | --- |
| 1 | J2.1 | GPIO0 | VBUS | J3.20 |
| 2 | J2.2 | GPIO1 | VSYS | J3.19 |
| 3 | J2.3 | GND | GND | J3.18 |
| 4 | J2.4 | GPIO2 | 3V3_EN | J3.17 |
| 5 | J2.5 | GPIO3 | 3V3 | J3.16 |
| 6 | J2.6 | GPIO4 | ADC_VREF | J3.15 |
| 7 | J2.7 | GPIO5 | GPIO28 | J3.14 |
| 8 | J2.8 | GND | GND | J3.13 |
| 9 | J2.9 | GPIO6 | GPIO27 | J3.12 |
| 10 | J2.10 | GPIO7 | GPIO26 | J3.11 |
| 11 | J2.11 | GPIO8 | RUN | J3.10 |
| 12 | J2.12 | GPIO9 | GPIO22 | J3.9 |
| 13 | J2.13 | GND | GND | J3.8 |
| 14 | J2.14 | GPIO10 | GPIO21 | J3.7 |
| 15 | J2.15 | GPIO11 | GPIO20 | J3.6 |
| 16 | J2.16 | GPIO12 | GPIO19 | J3.5 |
| 17 | J2.17 | GPIO13 | GPIO18 | J3.4 |
| 18 | J2.18 | GND | GND | J3.3 |
| 19 | J2.19 | GPIO14 | GPIO17 | J3.2 |
| 20 | J2.20 | GPIO15 | GPIO16 | J3.1 |

Source: [native 60-07 PCB](native-gpio-routing-60-07/native/rp2350-pico.kicad_pcb). Header placement and assignments are unchanged by the subsequent routing-only batches.

Source PCB SHA-256: `1b4b816146922ad06d0065334286c5e7c3bd06bb0682d3e4b05c726266078de0`.
