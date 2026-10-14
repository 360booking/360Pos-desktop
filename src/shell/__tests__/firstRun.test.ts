import { describe, expect, it } from 'vitest';

import { explainAddressError } from '../firstRun';

describe('first run: address errors in plain Romanian', () => {
  it('maps the shell_test_tenant / normalise errors', () => {
    expect(explainAddressError('Adresa restaurantului este goală.')).toMatch(/Scrie adresa/);
    expect(explainAddressError('Adresa trebuie să înceapă cu https://')).toMatch(/pizzeria\.360booking\.ro/);
    expect(explainAddressError('Nu răspunde: error sending request for url')).toMatch(/internet/);
    // the network error carries the URL — still a network error, not a format one
    expect(explainAddressError('Nu răspunde: error sending request for url (https://pizzeri.360booking.ro/api/health)')).toMatch(/internet/);
    expect(explainAddressError('Serverul a răspuns 404 Not Found')).toMatch(/nu e un restaurant 360booking/);
    expect(explainAddressError('Adresă invalidă: relative URL without a base')).toMatch(/Exemplu/);
  });
});
