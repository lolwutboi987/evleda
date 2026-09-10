import { canonicalIdentity } from "./canonical.js";

const ID_PREFIX = /^[a-z][a-z0-9_]{1,31}$/u;

export const deterministicId = (prefix: string, value: unknown): string => {
  if (!ID_PREFIX.test(prefix)) {
    throw new TypeError(`Invalid deterministic ID prefix: ${prefix}`);
  }
  const digest = canonicalIdentity(value, `evleda.id.${prefix}.v1`).digest;
  return `${prefix}_${digest.slice(0, 24)}`;
};

