// Public module registry used by OPFS/blob-loaded plugins. This is an
// explicit SDK membrane: kernel ownership APIs are intentionally absent.
// Dynamic plugins receive their own Cordis Context from apply(ctx); exposing
// the Cordis package lets them author normal Service/Plugin classes without
// exposing this runtime's root Context.
import * as Vue from 'vue';
import * as Cordis from '@deepseek-ai/cordis';
import * as Zod from 'zod';
import * as pi from '@earendil-works/pi-ai';
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions.lazy';
import * as sdk from '@/sdk';

export const modules = Object.freeze({
  'vue': Vue,
  '@deepseek-ai/cordis': Cordis,
  'zod': Zod,
  '@earendil-works/pi-ai': pi,
  '@earendil-works/pi-ai/api/openai-completions.lazy': openaiCompletions,
  '@harness/sdk': sdk,
});
