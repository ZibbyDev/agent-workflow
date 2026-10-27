/**
 * THE FOLDERS BLOCK: A REPOSITORY THE RUN CAN STILL PREPARE, AND WHO ELSE WAS
 * WORKING WHEN IT STARTED (run_log/magnum/2026-10-27-joint-candidate-half-landed).
 *
 * 855's developer read backend as "listed for choosing; not prepared in this
 * run, no files here", asked its manager for a work area, and cloned backend by
 * hand when there was no way to get one; that commit was never landed. The
 * runner now mounts a place for every editable repository of the project
 * (`status: "selectable"`, `preparable: true`): it reads as a folder not
 * prepared yet, which prepare_workspaces makes an editable work area.
 *
 * The runner's start-time copy of list_running_agents (`teammates`) is said
 * once, in the same block: each run's role, ticket, repositories, since when.
 *
 * [A/B] before: the preparable entry read as "listed for choosing; … no files
 * here", and no teammate line was ever said.
 */
import { describe, it, expect } from 'vitest';
import { preparedFoldersBlock, preparedWorkspaces, preparedProjectFolders } from '../repository-rules.js';

const ws = (extra: Record<string, unknown> = {}) => ({ LOCAL_PROJECT_CONTEXT: JSON.stringify({ workspaces: [
  { directory: '/workspace/local-project/tree/selfhosted', originalPath: '/Users/me/zibby/selfhosted', status: 'ready', access: 'editable', isPrimary: true },
  { directory: '/workspace/local-project/tree/backend', originalPath: '/Users/me/zibby/backend', status: 'selectable', preparable: true, kind: 'deferred', access: 'editable' },
], ...extra }) });

describe('a repository the run can still prepare', () => {
  it('reads as a folder not prepared yet, with its directory and the existing prepare sentence', () => {
    const block = preparedFoldersBlock(ws());
    expect(block).toContain('- /Users/me/zibby/backend → /workspace/local-project/tree/backend (editable; not prepared yet)');
    expect(block).toContain('For a folder marked not prepared yet, call prepare_workspaces');
    expect(block).not.toContain('listed for choosing');
  });
  it('is one of the run\'s folders, never its primary', () => {
    expect(preparedWorkspaces(ws()).map((w) => [w.pending === true, w.selectable === true, w.primary])).toEqual([[false, false, true], [true, false, false]]);
    expect(preparedProjectFolders(ws())).toContain('/workspace/local-project/tree/backend');
  });
});

describe('who else was working when the run started', () => {
  const teammates = { readAt: '2026-10-27T01:00:00.000Z', runs: [
    { executionId: 'cd70a090-6404-4354-8a5b-4db0a78da13a', workflowType: 'developer', ticketKey: '855', since: '2026-10-26T23:31:00.000Z', repositories: ['12-selfhosted', '12-backend'] },
    { executionId: '52ab7297-dbda-449e-afb0-fafd59706949', workflowType: 'board-runner', since: '2026-10-27T00:00:00.000Z' },
  ] };
  it('one line per run: role, run, ticket, since, repositories — and where to read it fresh', () => {
    const block = preparedFoldersBlock(ws({ teammates }));
    expect(block).toContain('Other runs of the project that were active when this run started (2026-10-27T01:00:00.000Z; list_running_agents lists them as they are now):');
    expect(block).toContain('- developer cd70a090-6404-4354-8a5b-4db0a78da13a, ticket 855, since 2026-10-26T23:31:00.000Z, working in 12-selfhosted, 12-backend');
    expect(block).toContain('- board-runner 52ab7297-dbda-449e-afb0-fafd59706949, since 2026-10-27T00:00:00.000Z');
  });
  it('nothing is said when the runner listed nobody or gave no list', () => {
    expect(preparedFoldersBlock(ws({ teammates: { readAt: 'x', runs: [] } }))).not.toContain('Other runs of the project');
    expect(preparedFoldersBlock(ws())).not.toContain('Other runs of the project');
  });
});
