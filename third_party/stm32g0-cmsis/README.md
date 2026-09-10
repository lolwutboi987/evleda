# Pinned STM32G0 CMSIS subset

This directory contains the smallest source subset used by EvlEDA's candidate-only
STM32G0B1CET6 cross-build. `manifest.json` pins every byte and the upstream tags
and commits. The ST device component is v1.4.5 and the Arm CMSIS Core is 5.6.0.

The generated linker memory ranges are derived from ST's v1.4.5
`Source/Templates/iar/linker/stm32g0b1xx_flash.icf`: Flash
`0x08000000..0x0807ffff` (512 KiB) and RAM
`0x20000000..0x20023fff` (144 KiB). Register definitions are consumed from the
pinned `stm32g0b1xx.h`; EvlEDA does not duplicate peripheral base addresses.

These sources and generated outputs remain candidate evidence. They do not
establish board-revision strap encoding, hardware behavior, qualification, or
manufacturing release.
