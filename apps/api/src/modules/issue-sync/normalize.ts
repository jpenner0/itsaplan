import { createHash } from 'node:crypto';
import type { IssueSyncFieldHashes } from '@repo/db';

// The synced fields in one comparable form for both sides. Hashes of these values are
// what the sync stores, so both directions must normalize through this file.

export type SyncStatus = 'open' | 'completed' | 'not_planned';

export interface SyncFields {
  title: string;
  description: string;
  status: SyncStatus;
  // Label names, matched case-insensitively.
  labels: string[];
  // The It's a Plan user id.
  assignee: string | null;
}

export type SyncField = keyof SyncFields;
export type FieldHashes = Required<IssueSyncFieldHashes>;

export const SYNC_FIELDS: SyncField[] = ['title', 'description', 'status', 'labels', 'assignee'];

// A trailing footer line, with the straight or the typographic apostrophe.
const FOOTER = /\n*Tracked in It[’']s a Plan: \[[^\]\n]+\]\([^)\s]+\)\s*$/;

export function stripFooter(body: string): string {
  return body.replace(FOOTER, '');
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').trimEnd();
}

export function normalizeDescription(body: string): string {
  return normalizeText(stripFooter(normalizeText(body)));
}

export function labelKey(name: string): string {
  return name.trim().toLowerCase();
}

export function stateTypeStatus(stateType: string): SyncStatus {
  if (stateType === 'completed') return 'completed';
  if (stateType === 'canceled') return 'not_planned';
  return 'open';
}

export function providerStatus(
  state: 'open' | 'closed',
  reason: 'completed' | 'not_planned' | 'reopened' | null,
): SyncStatus {
  if (state === 'open') return 'open';
  return reason === 'not_planned' ? 'not_planned' : 'completed';
}

export function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedValue(fields: SyncFields, field: SyncField): unknown {
  switch (field) {
    case 'title':
      return fields.title.trim();
    case 'description':
      return normalizeDescription(fields.description);
    case 'labels':
      return [...new Set(fields.labels.map(labelKey))].sort();
    default:
      return fields[field];
  }
}

export function fieldHashes(fields: SyncFields): FieldHashes {
  const hashes = {} as FieldHashes;
  for (const field of SYNC_FIELDS) hashes[field] = hashValue(normalizedValue(fields, field));
  return hashes;
}

// The hash of a whole synced state, stored as issue_sync_link.synced_hash.
export function stateHash(hashes: FieldHashes): string {
  return hashValue(SYNC_FIELDS.map((field) => hashes[field]));
}

export function commentHash(body: string): string {
  return hashValue(normalizeText(body));
}
