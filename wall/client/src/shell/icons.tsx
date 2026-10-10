// Rail icons, drawn as in the mockups: 24-unit grid, 1.8 stroke, round caps.
const paths: Record<string, preact.JSX.Element> = {
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="3" />
      <path d="M3.5 10h17M8 3.5v3M16 3.5v3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
};

export function Icon({ name }: { name: string }) {
  return (
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {paths[name] ?? <rect x="4" y="4" width="16" height="16" rx="4" />}
    </svg>
  );
}
