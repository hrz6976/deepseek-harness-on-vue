import { Service, type Context } from '@deepseek-ai/cordis';
import {
  defineComponent,
  h,
  markRaw,
  onErrorCaptured,
  provide,
  shallowReactive,
} from 'vue';
import type { Component, ComponentPublicInstance } from 'vue';
import { capabilityIsActive, recordCapabilityContribution } from './capabilities';
import { cordis, cordisContextKey } from './cordis';
import { log } from './log';

export interface UiContribution {
  name: string;
  component: Component;
  props?: Record<string, unknown> | null;
  region?: string;
  order?: number;
}

export interface UiContributionEntry extends UiContribution {
  id: string;
  owner: string;
  capabilityId: string;
  context: Context;
  version: number;
  error: string;
}

export const uiContributions = shallowReactive(new Map<string, UiContributionEntry>());
export const exposedStates = new Map<string, ComponentPublicInstance>();

export function makeExposeCapture(name: string) {
  let captured: ComponentPublicInstance | null = null;
  return (value: ComponentPublicInstance | null): void => {
    const internal = value?.$ as { exposed?: object | null } | undefined;
    if (value && internal?.exposed) {
      captured = value;
      exposedStates.set(name, value);
    } else if (captured && exposedStates.get(name) === captured) {
      exposedStates.delete(name);
      captured = null;
    }
  };
}

export class UiService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'ui');
  }

  register(definition: UiContribution): () => Promise<void> {
    if (!definition?.name?.trim()) throw new Error('a UI contribution needs a string name');
    if (!definition.component) throw new Error(`UI contribution "${definition.name}" needs a component`);

    const owner = this.ctx.fiber.name;
    const capabilityId = owner;
    const id = `${owner}:${definition.name}`;
    const previous = uiContributions.get(id);
    if (previous && previous.context.fiber !== this.ctx.fiber) {
      throw new Error(`duplicate UI contribution "${definition.name}" from plugin [${owner}]`);
    }

    const entry: UiContributionEntry = {
      ...definition,
      component: markRaw(definition.component),
      id,
      owner,
      capabilityId,
      context: this.ctx,
      version: 0,
      error: '',
    };
    const disposeContribution = recordCapabilityContribution(capabilityId, 'panels', definition.name);

    return this.ctx.effect(() => {
      uiContributions.set(id, entry);
      return () => {
        if (uiContributions.get(id) === entry) uiContributions.delete(id);
        disposeContribution();
      };
    }, `ui.register(${JSON.stringify(definition.name)})`);
  }
}

const uiKernelPlugin = {
  name: 'harness-ui-runtime',
  apply(ctx: Context) {
    new UiService(ctx);
  },
};

// UI is a kernel surface, not an OPFS plugin. It must exist before a dynamic
// Vue plugin arrives, while the plugin itself still owns each registration.
export const uiKernelFiber = cordis.plugin(uiKernelPlugin);

export const UiContributionHost = defineComponent({
  name: 'UiContributionHost',
  props: { contribution: { type: Object, required: true } },
  setup(props: { contribution: UiContributionEntry }) {
    provide(cordisContextKey, props.contribution.context);
    provide('pluginName', props.contribution.owner);
    provide('capabilityId', props.contribution.capabilityId);
    onErrorCaptured((error: unknown) => {
      props.contribution.error = error instanceof Error ? error.message : String(error);
      log(`plugin [${props.contribution.owner}] UI error: ${props.contribution.error}`, 'err');
      return false;
    });
    const retry = () => {
      props.contribution.error = '';
      props.contribution.version++;
    };
    const capture = makeExposeCapture(props.contribution.owner);
    return () => props.contribution.error
      ? h('div', { class: 'plugin-error' }, [
          h('div', `plugin ${props.contribution.owner} UI crashed: ${props.contribution.error}`),
          h('button', { onClick: retry }, 'retry UI'),
        ])
      : h(props.contribution.component, {
          ...(props.contribution.props ?? {}),
          key: props.contribution.version,
          ref: capture,
        });
  },
});

export const UiContributionsHost = defineComponent({
  name: 'UiContributionsHost',
  props: { region: { type: String, default: 'main' } },
  setup(props: { region: string }) {
    return () => [...uiContributions.values()]
      .filter(contribution => (contribution.region ?? 'main') === props.region && capabilityIsActive(contribution.capabilityId))
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.id.localeCompare(b.id))
      .map(contribution => h(UiContributionHost, {
      key: `${contribution.id}:${contribution.version}`,
      contribution,
      }));
  },
});
