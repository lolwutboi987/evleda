import type { PinAssignment, ReferenceControllerProfile } from "../knowledge/reference-controller-v0.js";

export const STM32G0B1_FLASH_ORIGIN = 0x08000000;
export const STM32G0B1_FLASH_BYTES = 512 * 1024;
export const STM32G0B1_RAM_ORIGIN = 0x20000000;
export const STM32G0B1_RAM_BYTES = 144 * 1024;

const CORE_VECTORS = [
  "_estack",
  "Reset_Handler",
  "NMI_Handler",
  "HardFault_Handler",
  "0", "0", "0", "0", "0", "0", "0",
  "SVC_Handler",
  "0", "0",
  "PendSV_Handler",
  "SysTick_Handler"
] as const;

const DEVICE_HANDLERS = [
  "WWDG_IRQHandler",
  "PVD_VDDIO2_IRQHandler",
  "RTC_TAMP_IRQHandler",
  "FLASH_IRQHandler",
  "RCC_CRS_IRQHandler",
  "EXTI0_1_IRQHandler",
  "EXTI2_3_IRQHandler",
  "EXTI4_15_IRQHandler",
  "USB_UCPD1_2_IRQHandler",
  "DMA1_Channel1_IRQHandler",
  "DMA1_Channel2_3_IRQHandler",
  "DMA1_Ch4_7_DMA2_Ch1_5_DMAMUX1_OVR_IRQHandler",
  "ADC1_COMP_IRQHandler",
  "TIM1_BRK_UP_TRG_COM_IRQHandler",
  "TIM1_CC_IRQHandler",
  "TIM2_IRQHandler",
  "TIM3_TIM4_IRQHandler",
  "TIM6_DAC_LPTIM1_IRQHandler",
  "TIM7_LPTIM2_IRQHandler",
  "TIM14_IRQHandler",
  "TIM15_IRQHandler",
  "TIM16_FDCAN_IT0_IRQHandler",
  "TIM17_FDCAN_IT1_IRQHandler",
  "I2C1_IRQHandler",
  "I2C2_3_IRQHandler",
  "SPI1_IRQHandler",
  "SPI2_3_IRQHandler",
  "USART1_IRQHandler",
  "USART2_LPUART2_IRQHandler",
  "USART3_4_5_6_LPUART1_IRQHandler",
  "CEC_IRQHandler"
] as const;

const CORE_HANDLERS = [
  "NMI_Handler",
  "HardFault_Handler",
  "SVC_Handler",
  "PendSV_Handler",
  "SysTick_Handler"
] as const;

/** Vector order follows ST cmsis-device-g0 v1.4.5 startup_stm32g0b1xx.s. */
export const stm32g0StartupSource = (): string => [
  ".syntax unified",
  ".cpu cortex-m0plus",
  ".fpu softvfp",
  ".thumb",
  "",
  ".global g_pfnVectors",
  ".global Default_Handler",
  ".global _init",
  ".global _fini",
  ".extern SystemInit",
  ".extern __libc_init_array",
  ".extern main",
  "",
  ".section .text.Reset_Handler,\"ax\",%progbits",
  ".global Reset_Handler",
  ".type Reset_Handler, %function",
  "Reset_Handler:",
  "  ldr r0, =_estack",
  "  mov sp, r0",
  "  bl SystemInit",
  "  ldr r0, =_sdata",
  "  ldr r1, =_edata",
  "  ldr r2, =_sidata",
  "1:",
  "  cmp r0, r1",
  "  bcs 2f",
  "  ldr r3, [r2]",
  "  str r3, [r0]",
  "  adds r0, r0, #4",
  "  adds r2, r2, #4",
  "  b 1b",
  "2:",
  "  ldr r0, =_sbss",
  "  ldr r1, =_ebss",
  "  movs r2, #0",
  "3:",
  "  cmp r0, r1",
  "  bcs 4f",
  "  str r2, [r0]",
  "  adds r0, r0, #4",
  "  b 3b",
  "4:",
  "  bl __libc_init_array",
  "  bl main",
  "5:",
  "  b 5b",
  ".size Reset_Handler, .-Reset_Handler",
  "",
  ".section .text.Default_Handler,\"ax\",%progbits",
  ".type Default_Handler, %function",
  "Default_Handler:",
  "  b Default_Handler",
  ".size Default_Handler, .-Default_Handler",
  "",
  ".section .text._init,\"ax\",%progbits",
  ".type _init, %function",
  "_init:",
  "  bx lr",
  ".size _init, .-_init",
  ".section .text._fini,\"ax\",%progbits",
  ".type _fini, %function",
  "_fini:",
  "  bx lr",
  ".size _fini, .-_fini",
  "",
  ...[...CORE_HANDLERS, ...DEVICE_HANDLERS].flatMap((handler) => [
    `.weak ${handler}`,
    `.thumb_set ${handler},Default_Handler`
  ]),
  "",
  ".section .isr_vector,\"a\",%progbits",
  ".type g_pfnVectors, %object",
  ".align 2",
  "g_pfnVectors:",
  ...[...CORE_VECTORS, ...DEVICE_HANDLERS].map((handler) => `  .word ${handler}`),
  ".size g_pfnVectors, .-g_pfnVectors",
  ".section .note.GNU-stack,\"\",%progbits",
  ""
].join("\n");

const outputPins = [
  "MOTOR_A_NSLEEP",
  "MOTOR_B_NSLEEP",
  "MOTOR_A_PWM",
  "MOTOR_B_PWM",
  "MOTOR_A_DIR",
  "MOTOR_B_DIR",
  "SENSOR_PWR_EN",
  "CAN_STB",
  "SPI_CS"
] as const;

const gpioFor = (pin: PinAssignment): { readonly port: string; readonly bit: number } => {
  const parsed = /^P(?<port>[A-D])(?<bit>\d{1,2})$/u.exec(pin.mcuPin);
  const bit = Number(parsed?.groups?.bit);
  if (parsed?.groups?.port === undefined || !Number.isInteger(bit) || bit < 0 || bit > 15) {
    throw new Error(`Target platform requires a reviewed GPIO mapping for ${pin.signal}.`);
  }
  return { port: parsed.groups.port, bit };
};

export const stm32g0PlatformSource = (profile: ReferenceControllerProfile): string => {
  if (profile.profileId !== "robotics-controller-v0" || profile.boardRevision !== "EVL-RC-G0-REV-A") {
    throw new Error("STM32G0 target platform generation is restricted to the exact reference profile.");
  }
  const pins = outputPins.map((signal) => {
    const pin = profile.pins.find((candidate) => candidate.signal === signal);
    if (pin === undefined) throw new Error(`Reference profile is missing ${signal}.`);
    return { signal, ...gpioFor(pin) };
  });
  const cases = pins.map((pin, index) => [
    `    case EVL_OUTPUT_${pin.signal}:`,
    `      binding.port = GPIO${pin.port};`,
    `      binding.mask = UINT32_C(1) << ${pin.bit.toString()}U;`,
    "      break;"
  ].join("\n"));
  return [
    '#include "board_contract.h"',
    '#include "stm32g0xx.h"',
    "",
    "typedef struct { GPIO_TypeDef *port; uint32_t mask; } EvlGpioBinding;",
    "",
    "static bool target_write_output(void *context, EvlOutput output, bool level) {",
    "  EvlGpioBinding binding = { NULL, 0U };",
    "  (void)context;",
    "  switch (output) {",
    ...cases,
    "    default: return false;",
    "  }",
    "  RCC->IOPENR |= RCC_IOPENR_GPIOAEN | RCC_IOPENR_GPIOBEN | RCC_IOPENR_GPIOCEN | RCC_IOPENR_GPIODEN;",
    "  (void)RCC->IOPENR;",
    "  binding.port->BSRR = level ? binding.mask : (binding.mask << 16U);",
    "  binding.port->OTYPER &= ~binding.mask;",
    "  binding.port->OSPEEDR &= ~(UINT32_C(3) << (__CLZ(__RBIT(binding.mask)) * 2U));",
    "  binding.port->PUPDR &= ~(UINT32_C(3) << (__CLZ(__RBIT(binding.mask)) * 2U));",
    "  binding.port->MODER = (binding.port->MODER & ~(UINT32_C(3) << (__CLZ(__RBIT(binding.mask)) * 2U))) |",
    "                        (UINT32_C(1) << (__CLZ(__RBIT(binding.mask)) * 2U));",
    "  return ((binding.port->ODR & binding.mask) != 0U) == level;",
    "}",
    "",
    "static bool target_board_revision_matches(void *context, const char *expected_revision) {",
    "  (void)context; (void)expected_revision;",
    "  /* EVL-RC-G0-REV-A has no reviewed raw PB14/PB15 strap encoding yet. Fail closed. */",
    "  return false;",
    "}",
    "",
    "static uint32_t target_read_fault_mask(void *context) {",
    "  (void)context;",
    "  /* Fault polarity/debounce and ADC qualification are not yet hardware-validated. */",
    "  return UINT32_MAX;",
    "}",
    "",
    "static bool target_configure_peripherals_disabled(void *context) {",
    "  (void)context;",
    "  /* Timer/ADC/DMA setup remains deliberately unavailable in this candidate. */",
    "  return false;",
    "}",
    "",
    "int main(void) {",
    "  const EvlBoardIo io = {",
    "    NULL, target_write_output, target_board_revision_matches,",
    "    target_read_fault_mask, target_configure_peripherals_disabled",
    "  };",
    "  const EvlInitStatus status = evl_board_init_safe(&io);",
    "  (void)status;",
    "  for (;;) { __WFI(); }",
    "}",
    ""
  ].join("\n");
};

/** Memory ranges are translated from ST v1.4.5 stm32g0b1xx_flash.icf. */
export const stm32g0LinkerScript = (): string => [
  "/* CANDIDATE ONLY. Memory ranges derive from ST cmsis-device-g0 v1.4.5. */",
  "ENTRY(Reset_Handler)",
  "_Min_Stack_Size = 0x400;",
  "MEMORY",
  "{",
  "  FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 512K",
  "  RAM   (xrw) : ORIGIN = 0x20000000, LENGTH = 144K",
  "}",
  "_estack = ORIGIN(RAM) + LENGTH(RAM);",
  "SECTIONS",
  "{",
  "  .isr_vector : ALIGN(4) { KEEP(*(.isr_vector)) } > FLASH",
  "  .text : ALIGN(4)",
  "  {",
  "    *(.text*) *(.rodata*)",
  "    KEEP(*(.init)) KEEP(*(.fini))",
  "    . = ALIGN(4);",
  "  } > FLASH",
  "  .ARM.extab : { *(.ARM.extab* .gnu.linkonce.armextab.*) } > FLASH",
  "  .ARM.exidx : { __exidx_start = .; *(.ARM.exidx*) __exidx_end = .; } > FLASH",
  "  .preinit_array : { PROVIDE_HIDDEN(__preinit_array_start = .); KEEP(*(.preinit_array*)) PROVIDE_HIDDEN(__preinit_array_end = .); } > FLASH",
  "  .init_array : { PROVIDE_HIDDEN(__init_array_start = .); KEEP(*(SORT(.init_array.*))) KEEP(*(.init_array*)) PROVIDE_HIDDEN(__init_array_end = .); } > FLASH",
  "  .fini_array : { PROVIDE_HIDDEN(__fini_array_start = .); KEEP(*(SORT(.fini_array.*))) KEEP(*(.fini_array*)) PROVIDE_HIDDEN(__fini_array_end = .); } > FLASH",
  "  _sidata = LOADADDR(.data);",
  "  .data : ALIGN(4)",
  "  {",
  "    _sdata = .; *(.data*) . = ALIGN(4); _edata = .;",
  "  } > RAM AT > FLASH",
  "  .bss (NOLOAD) : ALIGN(4)",
  "  {",
  "    _sbss = .; *(.bss*) *(COMMON) . = ALIGN(4); _ebss = .;",
  "  } > RAM",
  "  .stack (NOLOAD) : ALIGN(8)",
  "  {",
  "    . = . + _Min_Stack_Size; . = ALIGN(8);",
  "  } > RAM",
  "  /DISCARD/ : { *(.note*) *(.comment*) }",
  "}",
  "ASSERT(ADDR(.isr_vector) == ORIGIN(FLASH), \"vector table is not at flash origin\")",
  "ASSERT(_estack == 0x20024000, \"STM32G0B1 RAM end mismatch\")",
  "ASSERT((_edata <= ORIGIN(RAM) + LENGTH(RAM)) && (_ebss <= ORIGIN(RAM) + LENGTH(RAM)), \"RAM overflow\")",
  ""
].join("\n");
