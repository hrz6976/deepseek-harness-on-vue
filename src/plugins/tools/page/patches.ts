import type { Context } from '@deepseek-ai/cordis';
import { patchParameters, revertParameters } from './schemas';
import { request } from './command';

const previewDescription = 'Validate a transactional DOM patch without changing the page. Always preview a non-trivial patch before applying it.';
const applyDescription = 'Apply and verify a DOM adjustment as one undoable temporary transaction. Ordinary reversible patches need no separate confirmation; persistence still requires explicit approval.';
const revertDescription = 'Undo an applied page patch by transaction id.';

export function registerPatchesTools(ctx: Context): void {
  ctx.tools.register({
    name: 'page_patch_preview',
    description: previewDescription,
    parameters: patchParameters,
    run: ({ label, operations }) => request(ctx, { type: 'page/patch-preview', label, operations })
  });

  ctx.tools.register({
    name: 'page_patch_apply',
    description: applyDescription,
    parameters: patchParameters,
    run: ({ label, operations }) => request(ctx, { type: 'page/patch-apply', label, operations })
  });

  ctx.tools.register({
    name: 'page_patch_revert',
    description: revertDescription,
    parameters: revertParameters,
    run: ({ transactionId }) => request(ctx, { type: 'page/patch-revert', transactionId })
  });
}
