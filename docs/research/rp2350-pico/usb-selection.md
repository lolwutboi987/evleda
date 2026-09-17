# RP2350 USB-C circuit inputs

Research date: 2026-09-16. This records candidate parts and required connectivity,
not a USB compliance or system ESD result.

## Connector and sink configuration

Candidate connector: **GCT USB4105-GF-A**, a horizontal, top-mounted USB 2.0
Type-C receptacle. The base ordering code has 0.95 mm shell stakes; other suffixes
change stake length. Its recommended land pattern has four plated slots and two
0.65 mm non-plated locating holes. The stock KiCad footprint retains four physical
`SH` pads, overlapping A/B power-contact representations, and both locating
holes: 22 physical features and 17 logical terminals. The source matches the
manufacturer's named pin assignments and nominal land/slot dimensions; assembly
and board-edge fit still require review. [GCT drawing, revision B4, sheet 1](https://gct.co/files/drawings/usb4105.pdf).

The inspected stock footprint is
`Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal`,
7,170 bytes, SHA-256
`012da5bac71f8e9d4f59d0f7041c3cd8e1e5af3a3d297354b974f61ab24e8691`.
The separately downloaded drawing is 164,547 bytes, SHA-256
`fb331fbabee8392ed2937ed757c1610cb0f174b84625147c0b580a18eea8c0e5`.

The proposed port is a 5 V sink/device, without USB PD or alternate modes.
Connect A6/B6 together as D+ and A7/B7 as D-. Give A5/CC1 and B5/CC2 separate
5.1 kohm pull-downs to GND; leave A8/SBU1 and B8/SBU2 intentionally unconnected.
Both data-contact pairs remain actual physical endpoints in the design. This
arrangement does not authorize drawing 3 A or negotiating a higher voltage.
Input-current behavior, enumeration and the board/external-load budget remain
separate requirements. [Espressif hardware guide, device configuration and USB 2.0 pin mapping](https://docs.espressif.com/projects/esp-iot-solution/en/latest/usb/usb_overview/usb_typec_hardware_guide.html).

## RP2350 and protection connections

RP2350A pin 52 is USB_DP; pin 51 is USB_DM. Each requires its own 27 ohm series
resistor near the MCU, creating two launch nets and two connector-side nets.
Internal USB pullups/pulldowns do not remove the Type-C CC requirements. See the
[Raspberry Pi reference review](raspberry-pi-reference.md) for the applicable
hardware guide and unresolved stackup discrepancy.

**USBLC6-2SC6** is a protection candidate used by the Orpheus reference. Its
SOT23-6 pin map is IO1 on 1/6, GND on 2, IO2 on 3/4, and VBUS on 5. Maximum
specified IO-to-GND capacitance is 3.5 pF at the stated test bias. ST emphasizes
short data, supply and ground connections because parasitic inductance degrades
clamping. Device ratings alone do not establish board-level protection.
[ST DS4260 revision 7, pages 1-2 and 6](https://www.st.com/resource/en/datasheet/usblc6-2.pdf).

If selected, both signal-side pads per channel must remain represented. A
documented internal connection is not an invented PCB segment or permission to
remove physical endpoints. The final protection routing must be assessed as part
of the full channel, with its exact ground/supply return path and all copper
branches retained. The stock SC6 symbol is derived from another package's symbol;
the current stock resolver rejects inheritance, so source admission must be
resolved explicitly rather than silently substituting a different package.

## Toolbox work exposed by this circuit

The current closed interface contract only supports two member nets with fixed
endpoint roles. It rejects the required source-series split nets and extra USB-C
data contacts. The source geometry reader can observe varying track widths, but
the route writer currently writes one class width per net. A real connector
escape requires bounded narrow sections in addition to the wider coupled body.

Extend the declared channel to preserve four separate nets, resistor roles,
connector branches, protection anchors and terminal-bound escape lengths.
Measure every source-to-contact path, whole-channel skew and all opposing-net
clearances. Keep the ordinary two-net path unchanged when this extension is
absent. A calculation for a uniform body section must not qualify launches,
branches, resistors, protection devices or the complete USB interface.

The isolated `destination-usb-c-native-01` fixture is solely for native pad and
placement qualification. It deliberately marks data/CC/SBU pins NC and is not
the proposed USB circuit, a functioning port, or the RP2350 board.
