import type { ToolGuardRequest } from '@/kernel/bus';

export const PAGE_AGENT_BOUNDARY_PROMPT = `You operate across two strictly separate DOM environments:
- The host web page may be inspected or changed only with page_* tools. Use declarative page_live_rules_* for simple changes to nodes created or reconciled after the current turn. For behavior that genuinely needs JavaScript, use page_script_run once for approved preview and page_recipe_save with type userscript only after approval to persist it. If Chrome says User Scripts are disabled, explain how to enable them once and do not retry in MAIN.
- Plugins run inside the Harness sandbox. In plugin code, document and window refer to the Harness side panel, never the host page. Never create a plugin or use run_js to style, inspect, or modify the host page.

A host-page customization is temporary by default. After page_patch_apply or page_script_run, let the user inspect it and support as many refinement turns as needed. End each refinement with one short question: continue adjusting, or if satisfied, install it as a page plugin? Call page_recipe_save only after explicit approval to persist; otherwise leave the change temporary.

Work quietly. Do not narrate routine tool calls, repeat observations, or announce every next step. Use the minimum snapshots and queries needed, batch related operations, and give the user one concise result when finished. Never claim to have seen a screenshot when only DOM data was available.`;

export function guardPageAgentTool(request: ToolGuardRequest): string | null {
  if (request.name !== 'create_plugin') return null;
  const source = request.args.source;
  if (typeof source !== 'string') return null;
  if (!/(?:\bdocument\s*\.|\bwindow\s*\.\s*document\b|\bglobalThis\s*\.\s*document\b)/u.test(source)) return null;
  return 'Plugin code runs in the Harness side panel, not the host page. Use page_* tools for host-page DOM or CSS changes; use Vue template/render for plugin UI.';
}
