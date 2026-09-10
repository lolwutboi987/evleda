import { canonicalIdentity, contentIdentity } from "./canonical.js";
import { deterministicId } from "./ids.js";
import type {
  Requirement,
  RequirementSourceSpan,
  RequirementsDocument,
  UnresolvedAssumption
} from "../domain/types.js";

export interface ParsedRequirements {
  readonly document: RequirementsDocument;
  readonly blocking: readonly UnresolvedAssumption[];
}

interface NumberMatch {
  readonly value: number;
  readonly span: RequirementSourceSpan;
}

interface VoltageRangeMatch {
  readonly min: number;
  readonly max: number;
  readonly span: RequirementSourceSpan;
}

const spanFor = (prompt: string, index: number, value: string): RequirementSourceSpan => ({
  start: index,
  end: index + value.length,
  excerpt: prompt.slice(index, index + value.length)
});

const addRequirement = (
  output: Requirement[],
  requirement: Omit<Requirement, "id">
): void => {
  output.push({
    ...requirement,
    id: deterministicId("req", {
      category: requirement.category,
      statement: requirement.statement,
      normalizedValue: requirement.normalizedValue,
      sourceSpans: requirement.sourceSpans
    })
  });
};

const findVoltageRanges = (prompt: string): VoltageRangeMatch[] => {
  const matches: VoltageRangeMatch[] = [];
  const range = /(?<min>\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(?<max>\d+(?:\.\d+)?)\s*v(?:dc)?\b/giu;
  for (const match of prompt.matchAll(range)) {
    const min = Number(match.groups?.min);
    const max = Number(match.groups?.max);
    if (Number.isFinite(min) && Number.isFinite(max) && match.index !== undefined) {
      matches.push({ min, max, span: spanFor(prompt, match.index, match[0]) });
    }
  }
  return matches;
};

const findSingleSupplyVoltages = (prompt: string): NumberMatch[] => {
  const matches: NumberMatch[] = [];
  const patterns = [
    /(?:input|supply|battery|bus)(?:\s+voltage)?\s*(?:is|of|:|=)?\s*(?<value>\d+(?:\.\d+)?)\s*v(?:dc)?\b/giu,
    /(?<value>\d+(?:\.\d+)?)\s*v(?:dc)?\s+(?:input|supply|battery|bus)\b/giu
  ];
  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const value = Number(match.groups?.value);
      if (Number.isFinite(value) && match.index !== undefined) {
        matches.push({ value, span: spanFor(prompt, match.index, match[0]) });
      }
    }
  }
  return matches;
};

const findMotorCurrent = (prompt: string): NumberMatch | undefined => {
  const preferred = /(?<value>\d+(?:\.\d+)?)\s*a\s*(?:rms|continuous)(?:\s*(?:per|\/)\s*(?:motor|channel))?/iu.exec(prompt);
  const fallback = /(?:motor|channel)(?:\s+current)?\s*(?:is|of|:|=|target)?\s*(?<value>\d+(?:\.\d+)?)\s*a\b/iu.exec(prompt);
  const match = preferred ?? fallback;
  if (match?.groups?.value === undefined || match.index === undefined) {
    return undefined;
  }
  return {
    value: Number(match.groups.value),
    span: spanFor(prompt, match.index, match[0])
  };
};

const findInputCurrent = (prompt: string): NumberMatch | undefined => {
  const match = /(?:input|supply)(?:\s+current)?(?:\s+(?:limit|budget))?\s*(?:is|of|:|=)?\s*(?<value>\d+(?:\.\d+)?)\s*a\b/iu.exec(
    prompt
  );
  if (match?.groups?.value === undefined || match.index === undefined) {
    return undefined;
  }
  return {
    value: Number(match.groups.value),
    span: spanFor(prompt, match.index, match[0])
  };
};

const findMotorChannels = (prompt: string): NumberMatch | undefined => {
  const numeric = /(?<value>\d+)\s*(?:x|×|-)?\s*(?:channel|channels|motor|motors)\b/iu.exec(prompt);
  if (numeric?.groups?.value !== undefined && numeric.index !== undefined) {
    return {
      value: Number(numeric.groups.value),
      span: spanFor(prompt, numeric.index, numeric[0])
    };
  }

  const words: Readonly<Record<string, number>> = { one: 1, two: 2, dual: 2, three: 3, four: 4 };
  const word = /\b(?<value>one|two|dual|three|four)(?:[ -]?(?:channel|motor)(?:s)?|\s+(?:brushed[- ]?dc\s+)?motor\s+channels?)\b/iu.exec(prompt);
  if (word?.groups?.value !== undefined && word.index !== undefined) {
    return {
      value: words[word.groups.value.toLocaleLowerCase("en-US")] ?? 0,
      span: spanFor(prompt, word.index, word[0])
    };
  }
  return undefined;
};

const interfaces = [
  ["USB", /\busb(?:-c)?\b/iu],
  ["CAN", /\bcan(?:-fd)?\b/iu],
  ["UART", /\buart\b/iu],
  ["I2C", /\bi(?:2|²)c\b/iu],
  ["SPI", /\bspi\b/iu],
  ["SWD", /\bswd\b/iu],
  ["quadrature encoder", /\b(?:quadrature\s+)?encoder(?:s)?\b/iu]
] as const;

const excludedUseRules = [
  {
    id: "mains",
    description: "a mains-powered or mains-connected design",
    pattern: /\b(?:mains(?:[\p{Pd}\u2212\s]+(?:powered|connected|connection|input|supply|voltage))?|ac[\p{Pd}\u2212\s]+mains|(?:ac|utility)[\p{Pd}\u2212\s]+line|line[\p{Pd}\u2212\s]+(?:powered|connected|voltage)|utility[\p{Pd}\u2212\s]+power|grid[\p{Pd}\u2212\s]+(?:connected|power)|wall[\p{Pd}\u2212\s]+(?:power(?:ed)?|outlet)|household\s+(?:power|outlet)|(?:85|90|100|110|115|120|127|200|208|220|230|240|250|264|277)\s*(?:[\p{Pd}\u2212]\s*)?v(?:olts?)?\s*(?:ac|mains|alternating\s+current|(?=~)))\b/giu
  },
  {
    id: "battery_charging_or_bms",
    description: "battery charging, battery protection, or BMS functionality",
    pattern: /\b(?:b\s*\.?\s*m\s*\.?\s*s|batter(?:y|ies)[\p{Pd}\u2212\s]+(?:charg(?:e|er|ers|ing)|management(?:[\p{Pd}\u2212\s]+systems?)?|protection(?:[\p{Pd}\u2212\s]+circuits?)?)|charg(?:e|ing)[\p{Pd}\u2212\s]+(?:an?\s+|the\s+)?batter(?:y|ies)|cell[\p{Pd}\u2212\s]+balanc(?:e|er|ing)|(?:\d+\s*s[\p{Pd}\u2212\s]+)?(?:li[\p{Pd}\u2212\s]*po|lithium[\p{Pd}\u2212\s]+polymer)[\p{Pd}\u2212\s]+(?:battery[\p{Pd}\u2212\s]+)?charg(?:e|er|ers|ing))\b/giu
  },
  {
    id: "safety_rated",
    description: "a safety-rated or safety-critical control function",
    pattern: /\b(?:safety[\p{Pd}\u2212\s]+(?:rated|critical|certified)|functional\s+safety|s\s*\.?\s*i\s*\.?\s*l\s*(?:[\p{Pd}\u2212]\s*)?\d|safety\s+integrity\s+level\s+\d|a\s*\.?\s*s\s*\.?\s*i\s*\.?\s*l\s*(?:[\p{Pd}\u2212]\s*)?[a-d]|performance\s+level\s+[a-e]|pl\s*(?:[\p{Pd}\u2212]\s*)?[a-e]|iec\s*61508(?:[\p{Pd}\u2212\s]+compliant)?|iso\s*13849(?:[\p{Pd}\u2212\s]+compliant)?)\b/giu
  },
  {
    id: "human_carrying",
    description: "a human-carrying or person-carrying control function",
    pattern: /\b(?:(?:human|person|people|passenger|occupant)[\p{Pd}\u2212\s]+carrying|carr(?:y|ies|ying)[\p{Pd}\u2212\s]+(?:an?\s+)?(?:human|person|people|riders?|passengers?|occupants?)|(?:human|passenger|personal)[\p{Pd}\u2212\s]+transport|rideable|ride[\p{Pd}\u2212\s]+on|mobility\s+scooter|(?:powered|electric|motorized)\s+wheelchair|wheelchair\s+(?:controller|control|drive)|personal\s+mobility\s+vehicle|e[\p{Pd}\u2212\s]*bike|electric[\p{Pd}\u2212\s]+(?:bike|bicycle)|human[\p{Pd}\u2212\s]+vehicle)\b/giu
  },
  {
    id: "medical",
    description: "a medical, patient-connected, or life-support function",
    pattern: /\b(?:medical(?:[\p{Pd}\u2212\s]+(?:device|use|application|equipment|controller))?|patient[\p{Pd}\u2212\s]+(?:connected|facing|contact|monitor(?:ing)?|care|treatment)|life[\p{Pd}\u2212\s]+support|health[\p{Pd}\u2212\s]*care\s+device|clinical\s+(?:device|equipment|use|application)|diagnostic\s+(?:device|equipment)|therapy\s+device|insulin[\p{Pd}\u2212\s]+pump)\b/giu
  },
  {
    id: "certified_protection",
    description: "a certified protection function",
    pattern: /\b(?:(?:certified|certifiable|certification[\p{Pd}\u2212\s]+required|safety[\p{Pd}\u2212\s]+certified)[\p{Pd}\u2212\s]+(?:(?:electrical|motor|over[\p{Pd}\u2212\s]*current|over[\p{Pd}\u2212\s]*voltage|short[\p{Pd}\u2212\s]*circuit)[\p{Pd}\u2212\s]+)?(?:protection|protective[\p{Pd}\u2212\s]+(?:function|device|system))|(?:protection|protective[\p{Pd}\u2212\s]+(?:function|device|system))[\p{Pd}\u2212\s]+certified\s+(?:to|under|for|per))\b/giu
  },
  {
    id: "motor_safety",
    description: "a motor-safety, safe-torque-off, or emergency-stop function",
    pattern: /\b(?:motor[\p{Pd}\u2212\s]+safety|safe[\p{Pd}\u2212\s]+torque[\p{Pd}\u2212\s]+off|s\s*\.?\s*t\s*\.?\s*o|e\s*\.?\s*[\p{Pd}\u2212]?\s*stop|emergency[\p{Pd}\u2212\s]+(?:stop|shutdown|brake|braking)|safe[\p{Pd}\u2212\s]+stop\s+[12]|ss[12])\b/giu
  },
  {
    id: "autonomous_release",
    description: "autonomous manufacturing release",
    pattern: /\b(?:(?:autonomous(?:ly)?|automatic(?:ally)?|automated|agentic|unattended)[\p{Pd}\u2212\s]+(?:(?:manufacturing|fabrication|production|product)[\p{Pd}\u2212\s]+)?(?:release|handoff|submission|ordering)|auto[\p{Pd}\u2212\s]+release|(?:release|handoff|submit)(?:[\p{Pd}\u2212\s]+(?:to\s+)?(?:manufacturing|fabrication|production))?[\p{Pd}\u2212\s]+(?:(?:is\s+)?(?:automatic|autonomous|unattended)|automatically|autonomously|without\s+human\s+(?:approval|review))|(?:send|submit|order)[^.!?\r\n]{0,40}\b(?:manufacturing|fabrication|production)\b[^.!?\r\n]{0,20}\b(?:automatically|autonomously|unattended)\b|(?:automatically|autonomously)[\p{Pd}\u2212\s]+(?:send|submit|order)[^.!?\r\n]{0,40}\b(?:manufacturing|fabrication|production)\b)\b/giu
  }
] as const;

const sentenceStartBefore = (prompt: string, index: number): number => {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const character = prompt[cursor];
    if (character === "." || character === "?" || character === "!" || character === ";") {
      return cursor + 1;
    }
    if (character === "\n" || character === "\r") {
      const precedingLine = prompt.slice(0, cursor).trimEnd();
      if (precedingLine.endsWith(",") || /\b(?:and|or)$/iu.test(precedingLine)) {
        continue;
      }
      return cursor + 1;
    }
  }
  return 0;
};

const sentenceEndAfter = (prompt: string, index: number): number => {
  const endings = [".", "?", "!", ";", "\n", "\r"]
    .map((delimiter) => prompt.indexOf(delimiter, index))
    .filter((end) => end >= 0);
  const contrast = /\b(?:but|however|instead|yet|nevertheless|nonetheless|rather|although|though)\b/iu.exec(
    prompt.slice(index)
  );
  if (contrast?.index !== undefined) {
    endings.push(index + contrast.index);
  }
  return endings.length === 0 ? prompt.length : Math.min(...endings);
};

interface PolarityEvent {
  readonly index: number;
  readonly kind: "negative" | "affirmative" | "invert";
}

const requestIsNegated = (prompt: string, index: number, length: number): boolean => {
  const contextStart = sentenceStartBefore(prompt, index);
  const prefix = prompt.slice(contextStart, index);
  const events: PolarityEvent[] = [];

  for (const match of prefix.matchAll(
    /\b(?:no|not|never|without|cannot|free\s+of|exclude(?:d|s|ing)?|prohibit(?:ed|s|ing)?|forbid(?:den|s|ding)?|disallow(?:ed|s|ing)?|omit(?:ted|s|ting)?|avoid(?:ed|s|ing)?|out[\p{Pd}\u2212\s]+of[\p{Pd}\u2212\s]+scope)\b|\b(?:(?:is|are|was|were|do|does|did|could|will|would|should|must|shall)n['’]t|(?:can|won)['’]t)\b/giu
  )) {
    if (/^not\s+only\b/iu.test(prefix.slice(match.index))) {
      continue;
    }
    events.push({ index: match.index, kind: "negative" });
  }

  const directPrefix = prefix.slice(Math.max(0, prefix.length - 16));
  const directNon = /\bnon(?:[\p{Pd}\u2212]|\s)+$/iu.exec(directPrefix);
  if (directNon?.index !== undefined) {
    events.push({
      index: prefix.length - directPrefix.length + directNon.index,
      kind: "negative"
    });
  }

  for (const match of prefix.matchAll(
    /\b(?:but|however|instead|yet|nevertheless|nonetheless|rather|although|though)\b/giu
  )) {
    events.push({ index: match.index, kind: "affirmative" });
  }

  for (const match of prefix.matchAll(
    /\b(?:and|or)\s+(?=(?:no\b|(?:do|does|did|is|are|was|were|must|shall|should|will|would|can|could)\b))/giu
  )) {
    events.push({ index: match.index, kind: "affirmative" });
  }

  for (const match of prefix.matchAll(/\bexcept\b/giu)) {
    events.push({ index: match.index, kind: "invert" });
  }

  for (const match of prefix.matchAll(
    /[,;:\r\n]\s*(?:(?:and|or)\s+)?(?:(?:please|we|it|this|that|the\s+(?:controller|design|system)|controller|design|system)\s+)?(?:add|allow|build|charge|connect|enable|include|implement|integrate|make|operate|power|provide|require|support|use|release|is|are|will|must|shall|should|can)\b/giu
  )) {
    events.push({ index: match.index, kind: "affirmative" });
  }

  events.sort((left, right) => left.index - right.index);
  let negated = false;
  for (const event of events) {
    if (event.kind === "negative") {
      negated = !negated;
    } else if (event.kind === "affirmative") {
      negated = false;
    } else {
      negated = !negated;
    }
  }

  const suffix = prompt.slice(index + length, sentenceEndAfter(prompt, index + length));
  const postposedDoubleNegation = /^\s*(?:[\p{L}\p{N}_]+[\p{Pd}\u2212\s]+){0,16}(?:not(?!\s+only\b)|never)\s+(?:be\s+)?(?:excluded|prohibited|forbidden|disallowed|omitted|avoided|out[\p{Pd}\u2212\s]+of[\p{Pd}\u2212\s]+scope)\b/iu.test(
    suffix
  );
  if (postposedDoubleNegation) {
    return negated;
  }

  const postposedNegation = /^\s*(?:[\p{L}\p{N}_]+[\p{Pd}\u2212\s]+){0,16}(?:(?:is|are|was|were|must|shall|should|will|can)\s+)?(?:not(?!\s+only\b)|never|excluded|prohibited|forbidden|disallowed|omitted|out[\p{Pd}\u2212\s]+of[\p{Pd}\u2212\s]+scope)\b|^\s*(?:(?:(?:is|are|was|were|could|will|would|should|must|shall)n['’]t|(?:can|won)['’]t)\s+(?:be\s+)?(?:allowed|included|permitted|requested|required|supported|used)\b|[\p{Pd}\u2212]\s*(?:free|less)\b)/iu.test(
    suffix
  );
  return negated || postposedNegation;
};

const uniqueRanges = (ranges: readonly VoltageRangeMatch[]): readonly VoltageRangeMatch[] => {
  const seen = new Set<string>();
  return ranges.filter((range) => {
    const key = `${range.min}:${range.max}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

export const parseRequirements = (prompt: string): ParsedRequirements => {
  const requirements: Requirement[] = [];
  const assumptions: UnresolvedAssumption[] = [];
  const constraints: Record<string, string> = {
    reference_profile: "robotics-controller-v0",
    maximum_input_voltage_mv: "30000",
    maximum_total_current_ma: "5000"
  };
  const trimmed = prompt.trim();

  if (trimmed.length === 0) {
    assumptions.push({
      id: "assumption_missing_prompt",
      statement: "A non-empty source prompt is required.",
      severity: "blocking",
      sourceRequirementIds: []
    });
  }

  for (const rule of excludedUseRules) {
    const requestedMatch = [...prompt.matchAll(rule.pattern)].find(
      (match) => match.index !== undefined && !requestIsNegated(prompt, match.index, match[0].length)
    );
    if (requestedMatch === undefined) {
      continue;
    }
    assumptions.push({
      id: `assumption_excluded_${rule.id}`,
      statement: `Requested ${rule.description} is excluded from the v0 low-voltage prototype robotics-controller scope.`,
      severity: "blocking",
      sourceRequirementIds: []
    });
  }

  const explicitRanges = uniqueRanges(findVoltageRanges(prompt));
  const singleVoltages = findSingleSupplyVoltages(prompt);
  let selectedRange: VoltageRangeMatch | undefined;

  if (explicitRanges.length > 1) {
    assumptions.push({
      id: "assumption_conflicting_supply_voltage",
      statement: `Conflicting input voltage ranges were found: ${explicitRanges
        .map((range) => `${range.min}-${range.max} V`)
        .join(", ")}.`,
      severity: "blocking",
      sourceRequirementIds: []
    });
  } else if (explicitRanges[0] !== undefined) {
    selectedRange = explicitRanges[0];
  } else {
    const uniqueSingles = [...new Set(singleVoltages.map((entry) => entry.value))];
    if (uniqueSingles.length > 1) {
      assumptions.push({
        id: "assumption_conflicting_supply_voltage",
        statement: `Conflicting input supply voltages were found: ${uniqueSingles.join(", ")} V.`,
        severity: "blocking",
        sourceRequirementIds: []
      });
    } else if (singleVoltages[0] !== undefined) {
      selectedRange = {
        min: singleVoltages[0].value,
        max: singleVoltages[0].value,
        span: singleVoltages[0].span
      };
    }
  }

  if (selectedRange === undefined) {
    assumptions.push({
      id: "assumption_missing_supply_voltage",
      statement: "Input supply voltage or voltage range is ambiguous.",
      severity: "blocking",
      sourceRequirementIds: []
    });
  } else {
    constraints.input_voltage_min_mv = String(Math.round(selectedRange.min * 1000));
    constraints.input_voltage_max_mv = String(Math.round(selectedRange.max * 1000));
    addRequirement(requirements, {
      statement: `Operate from ${selectedRange.min}-${selectedRange.max} V DC input.`,
      category: "power",
      priority: "must",
      hazardClass: "electrical",
      normalizedValue: `${constraints.input_voltage_min_mv}:${constraints.input_voltage_max_mv}:mV`,
      sourceSpans: [selectedRange.span],
      verificationMethod: "Power-tree review and current-limited rail bring-up",
      acceptanceCriteria: "All rails remain within their approved tolerance across the declared input range."
    });
    if (selectedRange.min <= 0 || selectedRange.max > 30 || selectedRange.min > selectedRange.max) {
      assumptions.push({
        id: "assumption_supply_outside_v0_envelope",
        statement: "Input supply is outside the 0-30 V DC v0 prototype envelope.",
        severity: "blocking",
        sourceRequirementIds: requirements.at(-1) === undefined ? [] : [requirements.at(-1)!.id]
      });
    }
  }

  const motorChannels = findMotorChannels(prompt);
  const motorCurrent = findMotorCurrent(prompt);
  if (motorChannels === undefined || motorChannels.value <= 0) {
    assumptions.push({
      id: "assumption_missing_motor_channels",
      statement: "The number of motor/actuator channels is ambiguous.",
      severity: "blocking",
      sourceRequirementIds: []
    });
  } else {
    constraints.motor_channels = String(motorChannels.value);
    addRequirement(requirements, {
      statement: `Provide ${motorChannels.value} brushed-DC motor channel${motorChannels.value === 1 ? "" : "s"}.`,
      category: "actuator",
      priority: "must",
      hazardClass: "thermal",
      normalizedValue: `${motorChannels.value}:channels`,
      sourceSpans: [motorChannels.span],
      verificationMethod: "Schematic/netlist review and guarded-load bench test",
      acceptanceCriteria: "Every declared channel has an independently controlled safe-disable and fault path."
    });
  }

  if (motorCurrent === undefined || motorCurrent.value <= 0) {
    assumptions.push({
      id: "assumption_missing_motor_current",
      statement: "Continuous or RMS motor current per channel is ambiguous.",
      severity: "blocking",
      sourceRequirementIds: []
    });
  } else {
    constraints.motor_current_rms_ma = String(Math.round(motorCurrent.value * 1000));
    addRequirement(requirements, {
      statement: `Support ${motorCurrent.value} A RMS per motor channel within the selected reference profile.`,
      category: "actuator",
      priority: "must",
      hazardClass: "thermal",
      normalizedValue: `${constraints.motor_current_rms_ma}:mA:rms:per_channel`,
      sourceSpans: [motorCurrent.span],
      verificationMethod: "Current-limit calculation, thermal model, and guarded-load measurement",
      acceptanceCriteria: "Measured continuous current and thermal rise remain within approved component limits."
    });
    if (motorCurrent.value > 0.5) {
      assumptions.push({
        id: "assumption_motor_current_outside_reference",
        statement: "Requested continuous motor current exceeds the validated 0.5 A RMS/channel v0 profile.",
        severity: "blocking",
        sourceRequirementIds: requirements.at(-1) === undefined ? [] : [requirements.at(-1)!.id]
      });
    }
  }

  const inputCurrent = findInputCurrent(prompt);
  if (inputCurrent !== undefined) {
    constraints.input_current_limit_ma = String(Math.round(inputCurrent.value * 1000));
    if (
      motorChannels !== undefined &&
      motorCurrent !== undefined &&
      inputCurrent.value < motorChannels.value * motorCurrent.value
    ) {
      assumptions.push({
        id: "assumption_impossible_current_budget",
        statement: "Input current budget is lower than the declared aggregate motor RMS current before logic losses.",
        severity: "blocking",
        sourceRequirementIds: []
      });
    }
  }

  for (const [label, pattern] of interfaces) {
    const match = pattern.exec(prompt);
    if (match?.index === undefined) {
      continue;
    }
    addRequirement(requirements, {
      statement: `Provide ${label} connectivity under the reference-profile electrical contract.`,
      category: label.includes("encoder") ? "sensor" : "communication",
      priority: "must",
      hazardClass: "functional",
      normalizedValue: label,
      sourceSpans: [spanFor(prompt, match.index, match[0])],
      verificationMethod: "KiCad connectivity comparison and generated firmware-contract test",
      acceptanceCriteria: `${label} pins, voltage domain, ownership, polarity, and safe state match across schematic and firmware.`
    });
  }

  const exclusions = [
    "No mains-powered or mains-connected design",
    "No battery charging, battery protection, or BMS functionality",
    "No safety-rated or safety-critical control function",
    "No human-carrying or person-carrying control function",
    "No medical, patient-connected, or life-support function",
    "No certified protection function",
    "No motor-safety, safe-torque-off, emergency-stop, or emergency-brake function",
    "No autonomous manufacturing release"
  ];
  const sourcePrompt = contentIdentity(prompt);
  const identityPayload = {
    schemaVersion: "evleda.requirements.v1",
    sourcePrompt,
    requirements,
    constraints,
    exclusions,
    unresolvedAssumptions: assumptions
  };
  const document: RequirementsDocument = {
    ...identityPayload,
    schemaVersion: "evleda.requirements.v1",
    identity: canonicalIdentity(identityPayload, "evleda.requirements.v1")
  };
  return {
    document,
    blocking: assumptions.filter((assumption) => assumption.severity === "blocking")
  };
};

export const requirementsAreApprovable = (document: RequirementsDocument): boolean =>
  document.requirements.length > 0 &&
  !document.unresolvedAssumptions.some((assumption) => assumption.severity === "blocking");
