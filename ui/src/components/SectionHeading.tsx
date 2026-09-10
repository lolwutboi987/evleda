import type { ReactNode } from "react";

interface SectionHeadingProps {
  readonly id: string;
  readonly index: string;
  readonly title: string;
  readonly aside?: ReactNode;
}

export function SectionHeading({ id, index, title, aside }: SectionHeadingProps) {
  return (
    <div className="section-heading">
      <div className="section-title-lockup">
        <span className="section-index" aria-hidden="true">
          {index}
        </span>
        <h2 id={id}>{title}</h2>
      </div>
      {aside ? <div className="section-aside">{aside}</div> : null}
    </div>
  );
}
