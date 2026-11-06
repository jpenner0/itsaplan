import { randomUUID } from 'node:crypto';
import { Agent, type AgentConfig } from '@mastra/core/agent';
import type { createTool } from '@mastra/core/tools';
import { HttpError } from '#shared/lib';
import { getAgentInProject } from '../service';
import { buildOnAgent } from '../agent-build';
import { DEFAULT_MAX_STEPS, reasoningProviderOptions, resolveModel } from './index';
import { getMastra } from './observability';

// The run of a mail triage: an internal agent reads one email and answers with a draft. It is
// built apart from every other run because the email comes from an outside sender. The agent
// gets only the tools the caller hands in (read tools), never the ones enabled on the agent,
// no skills, no memory and no custom tools, and its only output is its answer.
export async function runTriageAgent(input: {
  agentId: number;
  projectId: number;
  runId: number;
  // Placed before the agent's own instructions, which a team adjusts to tune the triage.
  preamble: string;
  prompt: string;
  tools: Record<string, ReturnType<typeof createTool>>;
  abortSignal?: AbortSignal;
}): Promise<{
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  aborted: boolean;
  stepLimit: boolean;
}> {
  const row = await getAgentInProject(input.agentId, input.projectId);
  if (!row) throw new HttpError(404, 'Agent not found');
  if (row.kind !== 'internal') throw new HttpError(400, 'Only internal agents can be run');
  const config: AgentConfig = {
    id: `ai-agent-${row.id}`,
    name: row.name,
    instructions: input.preamble + (row.instructions ?? ''),
    model: await resolveModel(row, randomUUID()),
    tools: input.tools,
  };
  const agent = new Agent(
    await buildOnAgent(config, {
      agentId: row.id,
      teamId: row.teamId,
      projectId: input.projectId,
      runId: input.runId,
      trigger: 'mail_triage',
      routeTools: () => ({}),
    }),
  );
  agent.__registerMastra(getMastra());
  const maxSteps = row.maxSteps ?? DEFAULT_MAX_STEPS;
  const result = await agent.generate(input.prompt, {
    maxSteps,
    abortSignal: input.abortSignal,
    tracingOptions: {
      metadata: {
        agentId: row.id,
        teamId: row.teamId,
        projectId: input.projectId,
        runId: input.runId,
        trigger: 'mail_triage',
      },
    },
    ...(row.temperature != null ? { modelSettings: { temperature: row.temperature } } : {}),
    ...(row.reasoningEffort != null
      ? { providerOptions: reasoningProviderOptions(row.reasoningEffort) }
      : {}),
  });
  return {
    text: (result.text ?? '').trim(),
    usage:
      result.usage?.inputTokens == null
        ? null
        : { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens ?? 0 },
    aborted: input.abortSignal?.aborted ?? false,
    stepLimit: result.finishReason === 'tool-calls' && result.steps.length >= maxSteps,
  };
}
