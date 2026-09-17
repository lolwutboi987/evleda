# USB-C physical pad fixtures

`Connector_USB.pretty/USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal.kicad_mod`
is the exact stock KiCad 10.0.3 footprint used by the offline connector tests.

`native04-saved-post-import.kicad_pcb` and `native04-sync-reply.json` are the exact
saved PCB source and native sync response captured by destination-usb-c-native-04.
The run stopped at the host contract-pad guard before a full native PAD capture;
these files are **saved native source and a sync reply, not full PAD evidence**.
Tests construct their own explicitly offline PAD/protocol responses from this source.

The source has J1's 22 physical features (17 logical terminals, four plated oval
shield members and two unnumbered NPTH locating holes) and J2's two electrical pads.
Eight J1 terminals retain their exact native `unconnected-(...)` NC net names.
The sync reply retains three interim placement findings; successful import does
not establish final placement or electrical acceptance.

Provenance: project `d24647d2-0bfc-4b44-8cfa-08bd5face127`, diagnostic
`sync-diagnostic-primary-failure-7f3f8ffb-4163-4da1-9a7e-99ebcb8b720e.json`.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Original diagnostic | — | `bf1c4d0f62b4aebbb039514e5d1f3472e3612c0cd059eacccde466a5fe146929` |
| Saved post-import PCB | 14257 | `3bcb34016b6385a7d943ffdb9617d2d6619cbc2e847163351aa416741fc25014` |
| Native sync reply | 1496 | `22d532887640e10b166313035519e48157ef97a38d47887c373dc16fc7598b1c` |
