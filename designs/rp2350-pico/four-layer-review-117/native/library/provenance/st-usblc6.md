# USBLC6-2SC6 self-contained symbol

Reviewed 2026-09-17 against [ST USBLC6-2 datasheet DS4260 Rev.7, December2021](https://www.st.com/resource/en/datasheet/usblc6-2.pdf), p.1 top-view functional diagram and pp.2,6. The official PDF was read through the web document reader. Direct local download failed/timed out, so no local manufacturer-PDF hash is asserted.

| Pin | Vendor function | Local electrical type |
| --- | --- | --- |
| 1 | IO1 | passive |
| 2 | GND | power_in |
| 3 | IO2 | passive |
| 4 | IO2 | passive |
| 5 | VBUS | power_in |
| 6 | IO1 | passive |

This is an independently authored rectangular, single-unit symbol based on manufacturer pin facts; no stock symbol graphics were copied. The installed stock SC6 symbol inherits `USBLC6-2P6`, unsupported by the approved bounded reader. This symbol directly contains all six visible, unstacked terminals. Its default footprint remains the separately inspected stock `Package_TO_SOT_SMD:SOT-23-6`; this package does not duplicate or approve that stock footprint globally.

The IO terminals are passive ESD connections, not data sources. VBUS/GND are power-input ERC modelling choices. Both physical pins in each channel must receive board copper: an internal circuit relationship must not remove a physical endpoint or invent a PCB track. The simple body omits an internal equivalent-circuit drawing; the datasheet remains the authority for device internals. Placement/return-path quality and system ESD performance remain separate board-level work.
