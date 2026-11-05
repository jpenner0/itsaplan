'use client';

import type { AgentAnalyticsScope } from '@/lib/api/endpoints/agentAnalytics';

// Below the panels of an agent dashboard, over the scope and the window it shows. A
// self-hosted instance adds nothing; the hosted build renders its own panels.
export default function AgentAnalyticsExtras(_props: { scope: AgentAnalyticsScope; days: number }) {
  return null;
}
