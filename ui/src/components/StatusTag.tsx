import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { SealWarning } from "@phosphor-icons/react/dist/csr/SealWarning";
import { WarningOctagon } from "@phosphor-icons/react/dist/csr/WarningOctagon";
import { XCircle } from "@phosphor-icons/react/dist/csr/XCircle";
import type { ReactNode } from "react";
import { statusLabel } from "../model";

type Tone = "neutral" | "working" | "success" | "warning" | "danger";

const toneFor = (status: string): Tone => {
  if (status === "PROVISIONAL_POC" || status === "UNKNOWN") return "warning";
  if (status === "BLOCKED_DIAGNOSTIC" || status === "FAIL") return "danger";
  if (status === "PASS") return "success";
  if (status === "NOT_RUN" || status === "NOT_APPLICABLE") return "neutral";

  const normalized = status.toLocaleLowerCase("en-US");
  if (["pass", "succeeded", "completed", "qualified", "release_authorized"].includes(normalized)) {
    return "success";
  }
  if (["fail", "error", "blocked", "cancelled", "revoked"].includes(normalized)) return "danger";
  if (["running", "queued"].includes(normalized)) return "working";
  if (["review", "waiting_approval", "waiting_requirements_approval", "stale", "waived"].includes(normalized)) {
    return "warning";
  }
  return "neutral";
};

const iconFor = (tone: Tone): ReactNode => {
  if (tone === "success") return <CheckCircle aria-hidden="true" weight="fill" />;
  if (tone === "danger") return <XCircle aria-hidden="true" weight="fill" />;
  if (tone === "warning") return <SealWarning aria-hidden="true" weight="fill" />;
  if (tone === "working") return <Clock aria-hidden="true" weight="bold" />;
  return <WarningOctagon aria-hidden="true" weight="regular" />;
};

interface StatusTagProps {
  readonly status: string;
  readonly label?: string;
  readonly compact?: boolean;
}

export function StatusTag({ status, label, compact = false }: StatusTagProps) {
  const tone = toneFor(status);
  return (
    <span className={`status-tag status-${tone}${compact ? " status-tag-compact" : ""}`}>
      {iconFor(tone)}
      <span>{label ?? statusLabel(status)}</span>
    </span>
  );
}
