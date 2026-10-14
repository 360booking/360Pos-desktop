/** First-run screen helpers (StationSetup.tsx). */

/** Plain-Romanian reason for an address that did not pass the test. */
export function explainAddressError(raw: string): string {
  const t = raw.toLowerCase();
  if (/goală/.test(t)) return 'Scrie adresa restaurantului.';
  // Order matters: network errors carry the URL (https://…) in their text.
  if (/nu răspunde|dns|connect|timed out|error sending/.test(t)) {
    return 'Adresa nu răspunde. Verifică dacă e scrisă corect și dacă acest calculator are internet.';
  }
  if (/serverul a răspuns/.test(t)) return 'La adresa asta nu e un restaurant 360booking. Verifică adresa.';
  if (/trebuie să înceapă cu https/.test(t)) return 'Adresa trebuie să fie de forma pizzeria.360booking.ro (sau https://…).';
  if (/invalid|nu are domeniu/.test(t)) return 'Adresa nu pare corectă. Exemplu: pizzeria.360booking.ro';
  return raw;
}
