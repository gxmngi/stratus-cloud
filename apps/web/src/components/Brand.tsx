export function Brand({ symbolOnly = false }: { symbolOnly?: boolean }) {
  return (
    <span className="stratus-brand">
      <svg
        width="30"
        height="30"
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
      >
        <path d="m4 12 12-7 12 7-12 7L4 12Z" fill="currentColor" />
        <path
          d="m4 18 12 7 12-7M4 23l12 7 12-7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
      {!symbolOnly && (
        <span>
          stratus<span className="brand-cloud">cloud</span>
        </span>
      )}
    </span>
  );
}
