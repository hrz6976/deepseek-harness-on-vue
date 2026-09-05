import type { PageEvent } from '@/shared/page-protocol';
import { toJsonValue, type TaskRuntimeService } from '@/shared/runtime';
import type { HarnessArtifact } from '@/shared/task-model';

function changeSetMatches(artifact: HarnessArtifact, taskId: string, transactionId: string): boolean {
  return artifact.taskId === taskId && artifact.kind === 'change-set' && !!artifact.content
    && typeof artifact.content === 'object' && !Array.isArray(artifact.content)
    && artifact.content.transactionId === transactionId;
}

export async function recordPageArtifact(task: TaskRuntimeService, event: PageEvent): Promise<void> {
  const active = task.activeTask();
  if (!active) return;
  if (event.type === 'patch/applied') {
    if (!task.artifacts.some(artifact => changeSetMatches(artifact, active.id, event.transaction.id))) {
      await task.createArtifact({
        kind: 'change-set', title: event.transaction.label, status: 'verified', source: { type: 'provider', id: 'page' },
        content: { transactionId: event.transaction.id, url: event.transaction.scope.url, operations: toJsonValue(event.transaction.operations) },
        verification: { status: 'passed', checkedAt: Date.now(), summary: `${event.transaction.verification.filter(result => result.ok).length}/${event.transaction.verification.length} operations verified` },
      });
    }
  } else if (event.type === 'patch/reverted' || event.type === 'patch/verification-failed') {
    const artifact = task.artifacts.find(candidate => changeSetMatches(candidate, active.id, event.transaction.id));
    if (artifact) await task.updateArtifact(artifact.id, event.type === 'patch/reverted'
      ? { status: 'archived', verification: { status: 'unverified', checkedAt: Date.now(), summary: 'Reverted from the page.' } }
      : { status: 'failed', verification: { status: 'failed', checkedAt: Date.now(), summary: 'Page verification failed.' } });
  } else if (event.type === 'recipe/installed' && !task.artifacts.some(artifact =>
    artifact.taskId === active.id && artifact.kind === 'site-skill' && artifact.source.id === event.recipe.id)) {
    await task.createArtifact({
      kind: 'site-skill', title: event.recipe.name, status: event.recipe.enabled ? 'ready' : 'draft',
      source: { type: 'provider', id: event.recipe.id }, content: toJsonValue(event.recipe),
    });
  }
}
