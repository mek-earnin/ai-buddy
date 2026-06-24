import React, { ReactNode, useState } from 'react';

interface CollapsibleSectionProps {
  title: string;
  subtitle?: string;
  /** Optional non-interactive node shown on the right of the header (e.g. a status badge). */
  accessory?: ReactNode;
  /** Whether the section starts expanded. Defaults to open. */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Lightweight accordion wrapper. Renders a clickable header (title + subtitle +
 * chevron) and collapses its body. Kept presentation-only so each form stays
 * self-contained and could be rendered standalone.
 */
export default function CollapsibleSection({
  title,
  subtitle,
  accessory,
  defaultOpen = true,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={`settings-section ${open ? 'open' : 'collapsed'}`}>
      <button
        type="button"
        className="settings-section-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <svg
          className="settings-section-chevron"
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="settings-section-titles">
          <span className="settings-section-title">{title}</span>
          {subtitle && <span className="settings-section-sub">{subtitle}</span>}
        </span>
        {accessory && <span className="settings-section-accessory">{accessory}</span>}
      </button>
      {open && <div className="settings-section-body">{children}</div>}
    </section>
  );
}
