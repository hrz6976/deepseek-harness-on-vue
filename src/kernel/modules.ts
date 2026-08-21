// Shared-module registry behind dialect-v2 imports. Plugins load from OPFS
// source; a blob-URL import has no resolver and the bundle exposes no module
// URLs, so kernel/compile.js REWRITES their pinned import statements into
// destructuring reads of this frozen map (via globalThis.__harness.modules —
// the only thing blob-loaded code can reach). Everything here is statically
// imported exactly once, so plugin code shares THE bundle singletons: one
// Vue namespace (or reactivity silently breaks across the shipped/
// self-modified boundary), one pi-ai.
import * as Vue from 'vue';
import * as pi from '@earendil-works/pi-ai';
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions.lazy';
import * as services from './services';
import * as bus from './bus';
import * as log from './log';
import * as collector from './collector';
import * as host from './host';
import * as contrib from './contrib';
import * as compile from './compile';
import * as boot from './boot';
import * as runtime from '../shared/runtime';

export const modules = Object.freeze({
  'vue': Vue,
  '@earendil-works/pi-ai': pi,
  '@earendil-works/pi-ai/api/openai-completions.lazy': openaiCompletions,
  'kernel/services': services,
  'kernel/bus': bus,
  'kernel/log': log,
  'kernel/collector': collector,
  'kernel/host': host,
  'kernel/contrib': contrib,
  'kernel/compile': compile,
  'kernel/boot': boot,
  'shared/runtime': runtime,
});
