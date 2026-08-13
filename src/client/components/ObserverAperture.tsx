interface ObserverApertureProps {
  className?: string;
}

/** Telescope-inspired field of view with measurement arcs and an observed point. */
export function ObserverAperture({ className }: ObserverApertureProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M6.38 9.38A6.2 6.2 0 0 1 17.62 9.38"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M15.85 13.8A4.25 4.25 0 0 1 8.15 13.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="1.15" fill="currentColor" />
    </svg>
  );
}
