import { describe, expect, it } from 'vitest';

import { printerStationKey } from '../kitchenPrinters';

describe('printerStationKey — posturile vechi ale imprimantelor', () => {
  it('mapează kitchen / pizza pe cheile posturilor de bucătărie', () => {
    expect(printerStationKey('kitchen')).toBe('bucatarie');
    expect(printerStationKey(' Kitchen ')).toBe('bucatarie');
    expect(printerStationKey('')).toBe('bucatarie');
    expect(printerStationKey(null)).toBe('bucatarie');
    expect(printerStationKey('pizza')).toBe('pizzerie');
    expect(printerStationKey('bar')).toBe('bar');
  });

  it('lasă neatinse cheile reale și posturile proprii', () => {
    expect(printerStationKey('cofetarie')).toBe('cofetarie');
    expect(printerStationKey('grill-de-vara')).toBe('grill-de-vara');
  });
});
