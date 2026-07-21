/**
 * @receipta/core — the trust foundation.
 *
 * Zero runtime dependencies (Node `crypto` only). Exposes the receipt schema, RFC 8785
 * canonicalization, Ed25519 signing, the append-only store, hash-chain logic, and offline
 * verification. Adapters and the CLI build on this.
 */
export * from './canon.js';
export * from './crypto.js';
export * from './schema.js';
export * from './store.js';
export * from './chain.js';
export * from './trust.js';
export * from './adapter-support.js';
