/** Public, platform-neutral retrieval substrate. Android composition is opt-in via ./android. */
export * from './types';
export { LocalIndexingService, type IndexingPolicy } from './indexing';
export { LocalRetrievalService, DEFAULT_RRF } from './retrieval';
