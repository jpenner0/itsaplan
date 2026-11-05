import type { GodSection } from '@/utils/godSections';

// A self-hosted instance lists the core's god mode sections. The hosted build returns the
// core's with its own added, such as billing, or with one replaced or left out.
export default function godSections(core: GodSection[]): GodSection[] {
  return core;
}
