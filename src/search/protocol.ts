import type { SearchResponse, SearchStatus } from './index';

export type ToWorker =
  | { type: 'init'; repo: string; assets: { model: string; vocab: string } }
  | { type: 'changed'; dates: string[] }
  | { type: 'warm' }
  | { type: 'search'; id: number; query: string };

export type FromWorker =
  | { type: 'status'; status: SearchStatus }
  | { type: 'results'; id: number; response: SearchResponse }
  | { type: 'failed'; id: number; error: string };
