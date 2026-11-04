// Human-owned transport contract. Route table and status mapping are reviewed by people; the Sigil program never sees HTTP.
// Authentication is out of scope: the actor arrives in the headers x-actor-id and x-actor-role, as an upstream gateway would set them.

import type { DocError, Op } from './engine.js';

export const STATUS_OF: Record<DocError, number> = {
  NotAllowed: 403,
  Gone: 410,
  TooLong: 413,
  AlreadyPublished: 409,
  EmptyBody: 422,
  StoreFailed: 503,
};

export type Route = { method: string; pattern: RegExp; kind: 'view' | 'act' | 'audit'; op?: Op };

export const ROUTES: Route[] = [
  { method: 'GET', pattern: /^\/docs\/(\d+)$/, kind: 'view' },
  { method: 'PATCH', pattern: /^\/docs\/(\d+)$/, kind: 'act', op: 'Update' },
  { method: 'DELETE', pattern: /^\/docs\/(\d+)$/, kind: 'act', op: 'Delete' },
  { method: 'POST', pattern: /^\/docs\/(\d+)\/publish$/, kind: 'act', op: 'Publish' },
  { method: 'GET', pattern: /^\/audit$/, kind: 'audit' },
];
