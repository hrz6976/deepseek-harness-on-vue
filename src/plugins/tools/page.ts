import { getService } from '../../kernel/services';
import type { PageCommand, PatchOperation, SiteRecipe } from '../../shared/page-protocol';

interface SnapshotArgs { selector?: string; maxNodes?: number; maxDepth?: number }
interface QueryArgs { selector: string; limit?: number }
interface PatchArgs { label: string; operations: PatchOperation[] }
interface RecipeArgs { id?: string; name: string; matches: string[]; operations: PatchOperation[]; enabled?: boolean }

async function request(command: PageCommand): Promise<string> {
  const broker = getService('broker');
  if (!broker) return 'Error: the page broker is not available in this runtime';
  const result = await broker.request({ kind: 'page', command });
  return JSON.stringify(result);
}

export const pageToolsPlugin = {
  name: 'page',
  template: `
    <AgentTool name="page_snapshot" :description="snapshotDescription" :parameters="snapshotParameters" :run="snapshot" />
    <AgentTool name="page_query" :description="queryDescription" :parameters="queryParameters" :run="query" />
    <AgentTool name="page_patch_preview" :description="previewDescription" :parameters="patchParameters" :run="preview" />
    <AgentTool name="page_patch_apply" :description="applyDescription" :parameters="patchParameters" :run="apply" />
    <AgentTool name="page_patch_revert" :description="revertDescription" :parameters="revertParameters" :run="revert" />
    <AgentTool name="page_recipe_save" :description="recipeDescription" :parameters="recipeParameters" :run="saveRecipe" />
    <AgentTool name="page_recipe_list" description="List persisted site recipes and whether they are enabled." :parameters="emptyParameters" :run="listRecipes" />
    <AgentTool name="page_recipe_remove" description="Remove a persisted site recipe by id." :parameters="idParameters" :run="removeRecipe" />
    <AgentTool name="page_picker_start" description="Open the visual element picker so the user can click a page element and attach an annotation." :parameters="emptyParameters" :run="picker" />
    <PromptSection name="page-tools" :order="10" :text="pagePrompt" />
  `,
  setup() {
    const targetSchema = {
      type: 'object',
      properties: {
        nodeRef: { type: 'string' },
        selector: { type: 'string' },
        fingerprint: { type: 'object' },
      },
      required: ['nodeRef', 'selector', 'fingerprint'],
    };
    const operationSchema = {
      type: 'object',
      description: 'A transactional DOM operation. Use targets returned by page_snapshot or page_query unchanged.',
      properties: {
        kind: { type: 'string', enum: ['set-text', 'set-attribute', 'remove-attribute', 'set-style', 'add-class', 'remove-class', 'hide', 'remove', 'insert-html'] },
        target: targetSchema,
        value: { type: 'string' },
        name: { type: 'string' },
        property: { type: 'string' },
        priority: { type: 'string', enum: ['', 'important'] },
        position: { type: 'string', enum: ['beforebegin', 'afterbegin', 'beforeend', 'afterend'] },
        html: { type: 'string' },
      },
      required: ['kind', 'target'],
    };
    const snapshotParameters = {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector used as the snapshot root.' },
        maxNodes: { type: 'number', description: 'Maximum compressed nodes, default 600.' },
        maxDepth: { type: 'number', description: 'Maximum tree depth, default 10.' },
      },
    };
    const queryParameters = {
      type: 'object',
      properties: { selector: { type: 'string' }, limit: { type: 'number' } },
      required: ['selector'],
    };
    const patchParameters = {
      type: 'object',
      properties: {
        label: { type: 'string' },
        operations: { type: 'array', items: operationSchema },
      },
      required: ['label', 'operations'],
    };
    const revertParameters = {
      type: 'object',
      properties: { transactionId: { type: 'string' } },
      required: ['transactionId'],
    };
    const recipeParameters = {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Existing recipe id when updating; omit to create.' },
        name: { type: 'string' },
        matches: { type: 'array', items: { type: 'string' }, description: 'URL patterns such as https://example.com/*.' },
        operations: { type: 'array', items: operationSchema },
        enabled: { type: 'boolean' },
      },
      required: ['name', 'matches', 'operations'],
    };
    const idParameters = {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    };
    const emptyParameters = { type: 'object', properties: {} };

    return {
      snapshotDescription: 'Read a compressed, framework-neutral DOM snapshot of the active page. Returns stable element references for later patches.',
      queryDescription: 'Find elements in the active page with a CSS selector and return stable references and fingerprints.',
      previewDescription: 'Validate a transactional DOM patch without changing the page. Always preview a non-trivial patch before applying it.',
      applyDescription: 'Apply and verify a previously discussed DOM patch as one undoable transaction. Use only after the user has clearly approved the change.',
      revertDescription: 'Undo an applied page patch by transaction id.',
      recipeDescription: 'Install an approved DOM patch as an enabled page plugin so it reapplies after reload and navigation. The declarative recipe is its internal storage format.',
      pagePrompt: 'The host page is controlled only through these framework-neutral page_* DOM tools. Plugins and run_js do not run in the host DOM. Treat element references as capabilities: get them from page_snapshot/page_query, preserve their fingerprints, batch related changes, preview non-trivial patches, and never apply a patch without explicit user approval. Applied changes are temporary by default: let the user inspect and refine them, then ask whether to install the final result as a page plugin. Use page_recipe_save only after explicit approval to persist.',
      snapshotParameters,
      queryParameters,
      patchParameters,
      revertParameters,
      recipeParameters,
      idParameters,
      emptyParameters,
      snapshot: ({ selector, maxNodes, maxDepth }: SnapshotArgs = {}) => request({ type: 'page/snapshot', options: { selector, maxNodes, maxDepth } }),
      query: ({ selector, limit }: QueryArgs) => request({ type: 'page/query', selector, limit }),
      preview: ({ label, operations }: PatchArgs) => request({ type: 'page/patch-preview', label, operations }),
      apply: ({ label, operations }: PatchArgs) => request({ type: 'page/patch-apply', label, operations }),
      revert: ({ transactionId }: { transactionId: string }) => request({ type: 'page/patch-revert', transactionId }),
      picker: () => request({ type: 'page/picker-start' }),
      async saveRecipe({ id, name, matches, operations, enabled = true }: RecipeArgs) {
        const broker = getService('broker');
        if (!broker) return 'Error: the page broker is not available in this runtime';
        const now = Date.now();
        const recipe: SiteRecipe = {
          id: id ?? crypto.randomUUID(),
          name,
          matches,
          operations,
          enabled,
          world: 'ISOLATED',
          createdAt: now,
          updatedAt: now,
        };
        return JSON.stringify(await broker.request({ kind: 'recipe/save', recipe }));
      },
      async listRecipes() {
        const broker = getService('broker');
        return broker ? JSON.stringify(await broker.request({ kind: 'recipe/list' })) : 'Error: broker unavailable';
      },
      async removeRecipe({ id }: { id: string }) {
        const broker = getService('broker');
        return broker ? JSON.stringify(await broker.request({ kind: 'recipe/remove', id })) : 'Error: broker unavailable';
      },
    };
  },
};

export default pageToolsPlugin;
