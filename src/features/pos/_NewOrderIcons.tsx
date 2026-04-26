/** Lucide doesn't ship with chair / person / truck icons matching the
 * web POS exactly, so we use simple inline SVGs that fit the
 * surrounding density. Sprint 9. */
export function ChairIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 5v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5" />
      <path d="M3 13h18" />
      <path d="M7 21l1-6" />
      <path d="M17 21l-1-6" />
    </svg>
  );
}
export function PersonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="7" r="3" />
      <path d="M5 21c1.2-3 4-5 7-5s5.8 2 7 5" />
    </svg>
  );
}
export function TruckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17h11V6H3z" />
      <path d="M14 10h4l3 4v3h-7" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="18" r="2" />
    </svg>
  );
}
