/**
 * pos-core public surface.
 *
 * Pure TypeScript: no React, no I/O, no SQLite, no fetch, no COM port.
 * Drives the POS state machine and totals locally for UX/offline; the
 * backend remains the final authority on fiscal totals.
 */

export * from './types';
export * from './money';
export * from './vat';
export * from './calculator';
export * from './state-machine';
export * from './actions';
export * from './events';
