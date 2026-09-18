# RP2350 Pico library package v3

Successor to immutable v2. It preserves the three existing symbols and four footprints, adding the Wuerth four-terminal switch symbol/footprint, TDK bulk-capacitor lands within recommended ranges, and an unpopulated 20-contact PTH row. The 62-reference overlay is designs/rp2350-pico/library-selection.json. This package changes no host configuration or original draft.

Wuerth pairs 1/2 and 3/4 are manufacturer-defined. TDK PA 2.2 / PB 1.1 / PC 2.2 mm is an explicit engineering selection. J2/J3 have 1.7 mm copper and 1 mm bores; their courtyard denotes bare-contact access and implies no plastic header or castellations. The overlay corrects D1 to stock Nexperia_CFP3_SOD-123W. Read provenance and NOTICE.

Flash center CAD 9 remains internally unconnected metal tied to board GND by design choice. Marked-inductor orientation and every physical endpoint remain required. Source/pin/geometry checks and native exports close this library phase; board placement, copper/return paths, ERC/DRC, assembly and physical qualifications remain separate.
