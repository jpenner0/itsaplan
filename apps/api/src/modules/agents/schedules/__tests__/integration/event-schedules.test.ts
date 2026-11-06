import { describe, it, expect, beforeEach } from 'bun:test';
import { authedApi, type Api, createProject } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { createAgent, projectIdOf, teamOf } from '#tests/helpers/agents';
import { queueEventRuns, queueScheduleRuns } from '../../issue-runs';

// The event types: a schedule takes no cron and no column, and queueEventRuns queues
// one 'event' run per active schedule of the type in the project.

const schedules = (api: Api, projectKey = 'MKT') => api.projects({ projectKey })['agent-schedules'];

async function setup() {
  const owner = await signUpTestUser({ name: 'Owner' });
  const asOwner = authedApi(owner.cookie);
  await createProject(asOwner, { key: 'MKT', name: 'Marketing' });
  await createProject(asOwner, { key: 'OPS', name: 'Operations' });
  const mkt = await projectIdOf(asOwner, 'MKT');
  const ops = await projectIdOf(asOwner, 'OPS');
  const teamId = await teamOf(asOwner, 'MKT');
  const created = await createAgent(asOwner, 'MKT', {
    name: 'Triage Bot',
    username: 'triage',
    kind: 'external',
    projectIds: [mkt, ops],
  });
  const agent = created.data!.agent;
  const columns = (await asOwner.projects({ projectKey: 'MKT' }).get()).data!.columns;
  const backlog = columns.find((c) => c.stateType === 'backlog')!;
  const issue = (
    await asOwner.projects({ projectKey: 'MKT' }).issues.post({
      columnId: backlog.id,
      title: 'Checkout fails',
    })
  ).data!;
  return { asOwner, agent, mkt, ops, teamId, backlog, issue };
}

async function scheduleOf(api: Api, scheduleId: number) {
  return (await schedules(api).get({ query: {} })).data!.items.find((s) => s.id === scheduleId)!;
}

async function runsOf(api: Api, scheduleId: number, projectKey = 'MKT') {
  return (await schedules(api, projectKey)({ scheduleId }).runs.get()).data!;
}

const lead = 'GitHub issue MKT-1 "Checkout fails" was synced.';

describe('event agent schedules', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates both event types without a cron or a column', async () => {
    const { asOwner, agent } = await setup();
    for (const type of ['synced_issue_created', 'pull_request_opened']) {
      const created = await schedules(asOwner).post({
        agentId: agent.id,
        name: type,
        type,
        prompt: '  Triage it.  ',
      });
      expect(created.status).toBe(201);
      expect(created.data).toMatchObject({
        type,
        prompt: 'Triage it.',
        cron: null,
        nextRunAt: null,
        columnId: null,
        delaySec: 0,
        status: 'active',
        supported: true,
      });
      expect(await scheduleOf(asOwner, created.data!.id)).toMatchObject({ type, supported: true });
    }
  });

  it('refuses a cron or a column on an event type, also on an update', async () => {
    const { asOwner, agent, backlog } = await setup();
    const base = { agentId: agent.id, type: 'synced_issue_created' };

    const withCron = await schedules(asOwner).post({ ...base, name: 'A', cron: '0 9 * * *' });
    expect(withCron.status).toBe(400);
    const withColumn = await schedules(asOwner).post({ ...base, name: 'B', columnId: backlog.id });
    expect(withColumn.status).toBe(400);

    const created = (await schedules(asOwner).post({ ...base, name: 'C' })).data!;
    const patch = schedules(asOwner)({ scheduleId: created.id }).patch;
    expect((await patch({ cron: '0 9 * * *' })).status).toBe(400);
    expect((await patch({ columnId: backlog.id })).status).toBe(400);
    expect((await patch({ prompt: 'Label it.', delaySec: 30 })).data).toMatchObject({
      prompt: 'Label it.',
      delaySec: 30,
    });
    expect((await schedules(asOwner)({ scheduleId: created.id }).run.post()).status).toBe(400);
  });

  it('queues one event run per active schedule of the type in the project', async () => {
    const { asOwner, agent, mkt, issue } = await setup();
    const base = { agentId: agent.id, type: 'synced_issue_created' };
    const first = (await schedules(asOwner).post({ ...base, name: 'Triage', prompt: 'Label.' }))
      .data!;
    const second = (await schedules(asOwner).post({ ...base, name: 'Estimate' })).data!;
    const paused = (await schedules(asOwner).post({ ...base, name: 'Off', status: 'paused' }))
      .data!;
    const review = (
      await schedules(asOwner).post({ ...base, name: 'Review', type: 'pull_request_opened' })
    ).data!;
    const cron = (
      await schedules(asOwner).post({
        agentId: agent.id,
        name: 'Daily',
        prompt: 'Report.',
        cron: '0 9 * * *',
      })
    ).data!;
    const elsewhere = (await schedules(asOwner, 'OPS').post({ ...base, name: 'Triage OPS' })).data!;

    const runIds = await queueEventRuns({
      type: 'synced_issue_created',
      projectId: mkt,
      issueId: issue.id,
      lead,
    });
    expect(runIds).toHaveLength(2);

    const [firstRun] = await runsOf(asOwner, first.id);
    expect(firstRun).toMatchObject({ trigger: 'event', prompt: `${lead}\n\nLabel.` });
    const [secondRun] = await runsOf(asOwner, second.id);
    expect(secondRun).toMatchObject({
      trigger: 'event',
      prompt: `${lead} Review it and take the appropriate next step.`,
    });
    expect(runIds.sort()).toEqual([firstRun.id, secondRun.id].sort());

    expect(await runsOf(asOwner, paused.id)).toHaveLength(0);
    expect(await runsOf(asOwner, review.id)).toHaveLength(0);
    expect(await runsOf(asOwner, cron.id)).toHaveLength(0);
    expect(await runsOf(asOwner, elsewhere.id, 'OPS')).toHaveLength(0);

    const read = await scheduleOf(asOwner, first.id);
    expect(read.lastRunAt).not.toBeNull();
    expect(read.pendingRuns).toBe(1);
  });

  it('queues no run on an issue of another project', async () => {
    const { asOwner, agent, ops, issue } = await setup();
    const created = (
      await schedules(asOwner, 'OPS').post({
        agentId: agent.id,
        name: 'Triage',
        type: 'synced_issue_created',
      })
    ).data!;

    const runIds = await queueEventRuns({
      type: 'synced_issue_created',
      projectId: ops,
      issueId: issue.id,
      lead,
    });
    expect(runIds).toEqual([]);
    expect(await runsOf(asOwner, created.id, 'OPS')).toHaveLength(0);
  });

  it('queues no run once the agent no longer works in the project', async () => {
    const { asOwner, agent, mkt, ops, teamId, issue } = await setup();
    const created = (
      await schedules(asOwner).post({
        agentId: agent.id,
        name: 'Review',
        type: 'pull_request_opened',
      })
    ).data!;
    const moved = await asOwner
      .teams({ teamId })
      ['ai-agents']({ agentId: agent.id })
      .projects.put({ projectIds: [ops] });
    expect(moved.status).toBe(200);

    const runIds = await queueEventRuns({
      type: 'pull_request_opened',
      projectId: mkt,
      issueId: issue.id,
      lead: 'Pull request #12 references MKT-1.',
    });
    expect(runIds).toEqual([]);
    expect(await runsOf(asOwner, created.id)).toHaveLength(0);
  });

  it('leaves the event types out of the runs an extension queues', async () => {
    const { asOwner, agent, issue } = await setup();
    const created = (
      await schedules(asOwner).post({
        agentId: agent.id,
        name: 'Triage',
        type: 'synced_issue_created',
      })
    ).data!;

    await queueScheduleRuns([created.id], [issue.id], null, () => lead);
    expect(await runsOf(asOwner, created.id)).toHaveLength(0);
  });
});
