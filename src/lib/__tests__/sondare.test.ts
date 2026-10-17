import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({ getApiClient: () => ({ get: vi.fn() }) }));

import { intervalSondare, urmatoareaPolitica, type PoliticaSondare } from '../sondare';

const P = (o: Partial<PoliticaSondare> = {}): PoliticaSondare => ({
  configurat: true, inProgram: false, activ: false, rapid: false, motiv: 'inchis',
  intervalLentS: 300, panaLa: null, secundePanaLa: null, ...o,
});

describe('sondare după program', () => {
  it('fără politică / fără program: ca înainte', () => {
    expect(intervalSondare(8000, null)).toBe(8000);
    expect(intervalSondare(8000, P({ configurat: false, rapid: true }))).toBe(8000);
  });
  it('în program normal, noaptea la 5 minute', () => {
    expect(intervalSondare(8000, P({ inProgram: true, rapid: true }))).toBe(8000);
    expect(intervalSondare(8000, P())).toBe(300_000);
  });
  it('alertă deschisă sau atingere: normal', () => {
    expect(intervalSondare(8000, P(), true)).toBe(8000);
    expect(intervalSondare(8000, P(), false, true)).toBe(8000);
  });
  it('reîntreabă politica la schimbare', () => {
    expect(urmatoareaPolitica(P({ secundePanaLa: 10 }))).toBe(12_000);
    expect(urmatoareaPolitica(P())).toBe(300_000);
  });
});
