import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRequirements, requirementsAreApprovable } from "../../src/core/requirements.js";

const validPrompt = `
Build a two-channel brushed motor controller for a 7-16.8 V DC battery.
Each motor is limited to 0.5 A RMS. Provide USB-C, CAN, UART, I2C, SPI,
two quadrature encoders, and SWD programming.
`;

describe("requirements parser", () => {
  it("normalizes a supported reference prompt with source spans", () => {
    const result = parseRequirements(validPrompt);

    expect(result.blocking).toEqual([]);
    expect(requirementsAreApprovable(result.document)).toBe(true);
    expect(result.document.constraints).toMatchObject({
      input_voltage_min_mv: "7000",
      input_voltage_max_mv: "16800",
      motor_channels: "2",
      motor_current_rms_ma: "500"
    });
    expect(result.document.requirements.every((requirement) => requirement.sourceSpans.length > 0)).toBe(
      true
    );
  });

  it("blocks an ambiguous voltage instead of applying a default", () => {
    const result = parseRequirements("Build a two-channel low-voltage controller at 0.5 A RMS.");

    expect(result.blocking.map((entry) => entry.id)).toContain("assumption_missing_supply_voltage");
    expect(requirementsAreApprovable(result.document)).toBe(false);
  });

  it("blocks conflicting voltage ranges", () => {
    const result = parseRequirements(
      "Use a 7-16.8 V bus but also require a 18-24 V supply for two motors at 0.5 A RMS."
    );

    expect(result.blocking.map((entry) => entry.id)).toContain(
      "assumption_conflicting_supply_voltage"
    );
  });

  it("blocks an impossible current budget", () => {
    const result = parseRequirements(
      "Use a 12 V input with an input current limit of 0.5 A for two motors at 0.5 A RMS."
    );

    expect(result.blocking.map((entry) => entry.id)).toContain(
      "assumption_impossible_current_budget"
    );
  });

  it("blocks every documented excluded use while accepting explicit exclusions", () => {
    const cases = [
      ["assumption_excluded_mains", "Power the controller directly from 120 V AC mains.", "mains power"],
      ["assumption_excluded_battery_charging_or_bms", "Include an onboard battery charger and BMS.", "battery charging or a BMS"],
      ["assumption_excluded_safety_rated", "Make the motor control safety-rated to SIL 2.", "a safety-rated function"],
      ["assumption_excluded_human_carrying", "Use the controller in a human-carrying vehicle.", "a human-carrying function"],
      ["assumption_excluded_medical", "Use the controller as a medical device.", "a medical function"],
      ["assumption_excluded_certified_protection", "Provide certified electrical protection.", "certified protection"],
      ["assumption_excluded_motor_safety", "Provide safe torque off for both motors.", "safe torque off"],
      ["assumption_excluded_autonomous_release", "Automatically release the generated design for manufacturing.", "automatic manufacturing release"]
    ] as const;

    for (const [expectedId, request, excludedPhrase] of cases) {
      const denied = parseRequirements(`${validPrompt}\n${request}`);
      expect(denied.blocking.map((entry) => entry.id), request).toContain(expectedId);
      expect(requirementsAreApprovable(denied.document), request).toBe(false);

      const explicitlyExcluded = parseRequirements(`${validPrompt}\nDo not include ${excludedPhrase}.`);
      expect(explicitlyExcluded.blocking.map((entry) => entry.id), excludedPhrase).not.toContain(expectedId);
      expect(requirementsAreApprovable(explicitlyExcluded.document), excludedPhrase).toBe(true);
    }
  });

  it("keeps coordinated and postposed exclusions non-blocking", () => {
    const coordinated = parseRequirements(`${validPrompt}
      Do not include mains, a BMS, safety-rated control, passenger-carrying use,
      a medical device, certified protective functions, motor safety, STO, E-Stops,
      or autonomous fabrication release.`);

    expect(
      coordinated.blocking.filter((entry) => entry.id.startsWith("assumption_excluded_"))
    ).toEqual([]);
    expect(requirementsAreApprovable(coordinated.document)).toBe(true);

    const postposed = [
      "Mains connections are prohibited.",
      "BMS functionality is not included.",
      "Safety-rated control is out of scope.",
      "Passenger-carrying operation is forbidden.",
      "A medical device is not requested.",
      "Certified protection is excluded.",
      "Safe torque off must not be provided.",
      "Autonomous manufacturing release is disallowed."
    ];

    for (const exclusion of postposed) {
      const result = parseRequirements(`${validPrompt}\n${exclusion}`);
      expect(
        result.blocking.filter((entry) => entry.id.startsWith("assumption_excluded_")),
        exclusion
      ).toEqual([]);
      expect(requirementsAreApprovable(result.document), exclusion).toBe(true);
    }
  });

  it("does not turn disclaimer language into excluded-use requests", () => {
    const disclaimers = [
      "This is not a medical device.",
      "The controller isn't patient-connected.",
      "Medical use isn't allowed.",
      "Use a non-safety-rated controller.",
      "All applications except medical use are excluded.",
      "The controller is BMS-free and mains-free.",
      "The design is free of BMS functionality."
    ];

    for (const disclaimer of disclaimers) {
      const result = parseRequirements(`${validPrompt}\n${disclaimer}`);
      expect(
        result.blocking.filter((entry) => entry.id.startsWith("assumption_excluded_")),
        disclaimer
      ).toEqual([]);
      expect(requirementsAreApprovable(result.document), disclaimer).toBe(true);
    }
  });

  it("blocks excluded uses expressed through double negation", () => {
    const cases = [
      ["assumption_excluded_medical", "Do not exclude medical use."],
      ["assumption_excluded_medical", "Medical use is not prohibited."],
      ["assumption_excluded_motor_safety", "STO must not be omitted."]
    ] as const;

    for (const [expectedId, request] of cases) {
      const result = parseRequirements(`${validPrompt}\n${request}`);
      expect(result.blocking.map((entry) => entry.id), request).toEqual([expectedId]);
      expect(requirementsAreApprovable(result.document), request).toBe(false);
    }
  });

  it("does not carry negation across independent semicolon or newline clauses", () => {
    const cases = [
      "Do not include a BMS; Medical use is required.",
      "Do not include a BMS\nMedical use is required."
    ];

    for (const request of cases) {
      const result = parseRequirements(`${validPrompt}\n${request}`);
      expect(result.blocking.map((entry) => entry.id), request).toEqual([
        "assumption_excluded_medical"
      ]);
      expect(requirementsAreApprovable(result.document), request).toBe(false);
    }
  });

  it("recognizes long postposed exclusions without crossing contrast clauses", () => {
    const excluded = parseRequirements(
      `${validPrompt}\nMedical device functionality in every operating mode of the generated controller is explicitly prohibited.`
    );
    expect(excluded.blocking).toEqual([]);
    expect(requirementsAreApprovable(excluded.document)).toBe(true);

    const contrast = parseRequirements(
      `${validPrompt}\nMedical use is required but autonomous manufacturing release is explicitly prohibited.`
    );
    expect(contrast.blocking.map((entry) => entry.id)).toEqual(["assumption_excluded_medical"]);
    expect(requirementsAreApprovable(contrast.document)).toBe(false);
  });

  it("blocks concrete excluded-use phrase variants", () => {
    const cases = [
      ["assumption_excluded_battery_charging_or_bms", "Include a 4S LiPo charger."],
      ["assumption_excluded_medical", "Build an insulin-pump motor controller."],
      ["assumption_excluded_human_carrying", "Use the controller to power an e-bike."],
      ["assumption_excluded_human_carrying", "Use the controller in a human vehicle."],
      ["assumption_excluded_motor_safety", "The controller operates the emergency brake."]
    ] as const;

    for (const [expectedId, request] of cases) {
      const result = parseRequirements(`${validPrompt}\n${request}`);
      expect(result.blocking.map((entry) => entry.id), request).toEqual([expectedId]);
      expect(requirementsAreApprovable(result.document), request).toBe(false);
    }
  });

  it("publishes one exclusion entry for every enforced excluded-use family", () => {
    expect(parseRequirements(validPrompt).document.exclusions).toEqual([
      "No mains-powered or mains-connected design",
      "No battery charging, battery protection, or BMS functionality",
      "No safety-rated or safety-critical control function",
      "No human-carrying or person-carrying control function",
      "No medical, patient-connected, or life-support function",
      "No certified protection function",
      "No motor-safety, safe-torque-off, emergency-stop, or emergency-brake function",
      "No autonomous manufacturing release"
    ]);
  });

  it("checks every occurrence after negation and contrast boundaries", () => {
    const cases = [
      [
        "assumption_excluded_mains",
        "Mains power is prohibited; however, connect the input to 230 VAC."
      ],
      [
        "assumption_excluded_battery_charging_or_bms",
        "Do not include a BMS, but include battery charging."
      ],
      [
        "assumption_excluded_safety_rated",
        "This is not safety-rated; instead, implement functional safety."
      ],
      [
        "assumption_excluded_human_carrying",
        "Do not use it in a wheelchair controller, yet make it passenger-carrying."
      ],
      [
        "assumption_excluded_medical",
        "This is not a medical device, but it is patient-connected."
      ],
      [
        "assumption_excluded_certified_protection",
        "Certified protection is excluded; however, provide a certified protective function."
      ],
      [
        "assumption_excluded_motor_safety",
        "No motor safety is needed, but add an emergency shutdown."
      ],
      [
        "assumption_excluded_autonomous_release",
        "Do not autonomously release it; instead, release to fabrication automatically."
      ]
    ] as const;

    for (const [expectedId, request] of cases) {
      const result = parseRequirements(`${validPrompt}\n${request}`);
      expect(result.blocking.map((entry) => entry.id), request).toContain(expectedId);
    }

    const notOnly = parseRequirements(
      `${validPrompt}\nThis is not only a medical device but also patient-connected.`
    );
    expect(notOnly.blocking.map((entry) => entry.id)).toContain("assumption_excluded_medical");
  });

  it("blocks Unicode, acronym, and reordered variants for every excluded-use family", () => {
    const cases = [
      ["assumption_excluded_mains", "Accept 90–264 V AC utility power."],
      ["assumption_excluded_mains", "Use a line‑powered input."],
      ["assumption_excluded_mains", "Plug a 230V~ input into a wall outlet."],
      ["assumption_excluded_battery_charging_or_bms", "Add a battery‑management system."],
      ["assumption_excluded_battery_charging_or_bms", "The board must charge the battery."],
      ["assumption_excluded_battery_charging_or_bms", "Include a B.M.S."],
      ["assumption_excluded_battery_charging_or_bms", "Perform active cell balancing."],
      ["assumption_excluded_safety_rated", "Implement SIL‑2 functional safety."],
      ["assumption_excluded_safety_rated", "Require ASIL‑D operation."],
      ["assumption_excluded_safety_rated", "Build an IEC 61508 compliant function."],
      ["assumption_excluded_human_carrying", "Drive a passenger‑carrying platform."],
      ["assumption_excluded_human_carrying", "Use it as a wheelchair controller."],
      ["assumption_excluded_human_carrying", "Build a personal transport controller."],
      ["assumption_excluded_medical", "Use patient‑connected monitoring."],
      ["assumption_excluded_medical", "Deploy it in a clinical application."],
      ["assumption_excluded_medical", "Build patient-facing equipment."],
      ["assumption_excluded_certified_protection", "Implement a certified protective function."],
      ["assumption_excluded_certified_protection", "Use certified‑protection."],
      ["assumption_excluded_certified_protection", "Use protection certified to IEC 61508."],
      ["assumption_excluded_motor_safety", "Provide an E‑Stop and S.T.O."],
      ["assumption_excluded_motor_safety", "Implement safe stop 1."],
      ["assumption_excluded_autonomous_release", "Create an autonomous fabrication handoff."],
      ["assumption_excluded_autonomous_release", "Release to fabrication automatically."],
      ["assumption_excluded_autonomous_release", "Create an automated manufacturing release."],
      ["assumption_excluded_autonomous_release", "Automatically submit to fabrication."],
      ["assumption_excluded_autonomous_release", "Release to manufacturing is automatic."]
    ] as const;

    for (const [expectedId, request] of cases) {
      const result = parseRequirements(`${validPrompt}\n${request}`);
      expect(result.blocking.map((entry) => entry.id), request).toContain(expectedId);
    }
  });

  it("is deterministic for the same prompt", () => {
    expect(parseRequirements(validPrompt).document.identity).toEqual(
      parseRequirements(validPrompt).document.identity
    );
  });

  it("keeps the checked-in acceptance prompts aligned with their expected gates", () => {
    const readPrompt = (name: string): string =>
      readFileSync(new URL(`../../examples/prompts/${name}.txt`, import.meta.url), "utf8");

    expect(parseRequirements(readPrompt("reference-controller-v0")).blocking).toEqual([]);
    expect(
      parseRequirements(readPrompt("ambiguous-voltage")).blocking.map((entry) => entry.id)
    ).toContain("assumption_missing_supply_voltage");
    expect(
      parseRequirements(readPrompt("impossible-current-budget")).blocking.map((entry) => entry.id)
    ).toContain("assumption_impossible_current_budget");
  });
});
