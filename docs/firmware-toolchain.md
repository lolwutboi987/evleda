# STM32G0 candidate cross-build

The firmware stage has two independent gates:

1. `EVLEDA_FIRMWARE_CC` selects an absolute host compiler for the executable C11
   contract test.
2. `EVLEDA_ARM_GCC_ROOT` selects an absolute portable Arm GNU Toolchain root for
   the Cortex-M0+ freestanding build. EvlEDA never searches `PATH` for this toolchain.

The supported distribution is Arm GNU Toolchain 14.2.Rel1 for Windows,
`arm-gnu-toolchain-14.2.rel1-mingw-w64-i686-arm-none-eabi.zip`. Its official Arm
URL is
`https://developer.arm.com/-/media/Files/downloads/gnu/14.2.rel1/binrel/arm-gnu-toolchain-14.2.rel1-mingw-w64-i686-arm-none-eabi.zip`
and its official `.sha256asc` records SHA-256
`6facb152ce431ba9a4517e939ea46f057380f8f1e56b62e8712b3f3b87d994e1`.

Example portable configuration:

```powershell
$env:EVLEDA_ARM_GCC_ROOT = 'D:\Codex-Recovery\tools\arm-gnu-toolchain-14.2.rel1-mingw-w64-i686-arm-none-eabi'
$env:EVLEDA_FIRMWARE_BUILD_ROOT = 'D:\Codex-Recovery\evleda-runs\firmware-build'
pnpm test
```

Provisioning binds the content identities of `arm-none-eabi-gcc`, its `cc1`,
assembler and `collect2` helpers, the actual linker, `objcopy`, `nano.specs`,
`nosys.specs`, the Cortex-M0+ `libgcc`, `libc_nano`,
and `libnosys`, plus every pinned CMSIS support file. Missing helpers, version
mismatches, and post-provision byte changes fail closed. Child processes receive
explicit full executable paths and an environment without `PATH`.

The generated startup/vector order and register types come from ST's pinned
`cmsis-device-g0` v1.4.5 component. The CMSIS Core subset is pinned to Arm
CMSIS_5 5.6.0. The 512 KiB Flash and 144 KiB RAM ranges are translated from
ST's v1.4.5 STM32G0B1 linker template and guarded by linker assertions.

A passing target build emits identity-bound ELF, BIN, map, and exact invocation
records. All are classified `compiled-non-flashable-candidate`, with
`flashable: false` and `releaseAuthorized: false`. The platform forces all nine
controlled outputs to their safe levels before changing GPIO mode. Board strap
encoding, live fault interpretation, ADC calibration, and peripheral setup are
not reviewed or physically validated, so initialization deliberately fails
closed and the generated image never enables an actuator.
