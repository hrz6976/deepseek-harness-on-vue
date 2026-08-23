// Public module registry used by OPFS/blob-loaded plugins. This is an
// explicit SDK membrane: kernel ownership APIs are intentionally absent.
// Dynamic plugins receive their own Cordis Context from apply(ctx); exposing
// the Cordis package lets them author normal Service/Plugin classes without
// exposing this runtime's root Context.
import * as Vue from 'vue';
import * as Cordis from '@deepseek-ai/cordis';
import * as Zod from 'zod';
import * as sdk from '@/sdk';

let pi: typeof import('@earendil-works/pi-ai') | undefined;
let openaiCompletions: typeof import('@earendil-works/pi-ai/api/openai-completions.lazy') | undefined;

function loaded<T>(name: string, module: T | undefined): T {
  if (!module) throw new Error(`public plugin module "${name}" was not prepared`);
  return module;
}

export const modules = Object.freeze({
  'vue': Vue,
  '@deepseek-ai/cordis': Cordis,
  'zod': Zod,
  get '@earendil-works/pi-ai'() { return loaded('@earendil-works/pi-ai', pi); },
  get '@earendil-works/pi-ai/api/openai-completions.lazy'() {
    return loaded('@earendil-works/pi-ai/api/openai-completions.lazy', openaiCompletions);
  },
  '@harness/sdk': sdk,
});

export async function preparePluginModules(source: string): Promise<void> {
  const imports = (specifier: string) => new RegExp(
    `\\bfrom\\s*(['"])${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'u',
  ).test(source);
  await Promise.all([
    imports('@earendil-works/pi-ai') && !pi
      ? import('@earendil-works/pi-ai').then(module => { pi = module; }) : undefined,
    imports('@earendil-works/pi-ai/api/openai-completions.lazy') && !openaiCompletions
      ? import('@earendil-works/pi-ai/api/openai-completions.lazy').then(module => { openaiCompletions = module; }) : undefined,
  ]);
}
