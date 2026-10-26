import { describe, expect, it } from 'vitest';

import { modulBucatariei, printerStationKey } from '../kitchenPrinters';

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

describe('modulBucatariei — alegerea simplă pentru toate posturile', () => {
  it('întoarce modul comun; lipsa modului înseamnă kds', () => {
    expect(modulBucatariei([])).toBe('kds');
    expect(modulBucatariei([{}])).toBe('kds');
    expect(modulBucatariei([{ mode: 'kds' }, {}])).toBe('kds');
    expect(modulBucatariei([{ mode: 'imprimanta' }, { mode: 'imprimanta' }])).toBe('imprimanta');
    expect(modulBucatariei([{ mode: 'ambele' }])).toBe('ambele');
  });

  it('posturi cu moduri diferite → „diferit”', () => {
    expect(modulBucatariei([{ mode: 'kds' }, { mode: 'imprimanta' }])).toBe('diferit');
    expect(modulBucatariei([{}, { mode: 'ambele' }])).toBe('diferit');
  });
});
