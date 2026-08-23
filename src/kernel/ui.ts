import { Service, type Context } from '@deepseek-ai/cordis';
import {
  defineComponent,
  h,
  markRaw,
  onErrorCaptured,
  provide,
  shallowReactive,
} from 'vue';
import type { ComponentPublicInstance } from 'vue';
import type { UiContribution } from '@/shared/runtime';
import { capabilityForContext, recordCapabilityContribution } from './capabilities';
import { cordisContextKey } from './cordis';
import { log } from './log';
import { useService } from './services';

interface UiContributionEntry extends UiContribution {
  id: string;
  owner: string;
  context: Context;
  stateRef: (value: ComponentPublicInstance | null) => void;
  version: number;
  error: string;
}

export class UiService extends Service {
  readonly contributions = shallowReactive(new Map<string, UiContributionEntry>());
  private readonly states = new Map<string, ComponentPublicInstance>();

  constructor(ctx: Context) {
    super(ctx, 'ui');
  }

  capture(name: string) {
    let captured: ComponentPublicInstance | null = null;
    return (value: ComponentPublicInstance | null): void => {
      const exposed = (value?.$ as { exposed?: object | null } | undefined)?.exposed;
      if (value && exposed) {
        captured = value;
        this.states.set(name, value);
      } else if (captured && this.states.get(name) === captured) {
        this.states.delete(name);
        captured = null;
      }
    };
  }

  listState() { return [...this.states].map(([name, state]) => ({ name, keys: Object.keys(state) })); }
  readState(name: string) { return this.states.get(name) ?? null; }

  register(definition: UiContribution): () => Promise<void> {
    if (!definition?.name?.trim()) throw new Error('a UI contribution needs a string name');
    if (!definition.component) throw new Error(`UI contribution "${definition.name}" needs a component`);

    const owner = capabilityForContext(this.ctx)?.manifest.id ?? this.ctx.fiber.name;
    const id = `${owner}:${definition.name}`;
    const previous = this.contributions.get(id);
    if (previous && previous.context.fiber !== this.ctx.fiber) {
      throw new Error(`duplicate UI contribution "${definition.name}" from plugin [${owner}]`);
    }

    const entry: UiContributionEntry = {
      ...definition,
      component: markRaw(definition.component),
      id,
      owner,
      context: this.ctx,
      stateRef: this.capture(owner),
      version: 0,
      error: '',
    };
    const disposeContribution = recordCapabilityContribution(owner, 'panels', definition.name);

    return this.ctx.effect(() => {
      this.contributions.set(id, entry);
      return () => {
        if (this.contributions.get(id) === entry) this.contributions.delete(id);
        disposeContribution();
      };
    }, `ui.register(${JSON.stringify(definition.name)})`);
  }
}

export const uiKernelPlugin = {
  name: 'harness-ui-runtime',
  apply(ctx: Context) {
    new UiService(ctx);
  },
};

const UiContributionHost = defineComponent({
  name: 'UiContributionHost',
  props: { contribution: { type: Object, required: true } },
  setup(props: { contribution: UiContributionEntry }) {
    provide(cordisContextKey, props.contribution.context);
    onErrorCaptured((error: unknown) => {
      props.contribution.error = error instanceof Error ? error.message : String(error);
      log(`plugin [${props.contribution.owner}] UI error: ${props.contribution.error}`, 'err');
      return false;
    });
    const retry = () => {
      props.contribution.error = '';
      props.contribution.version++;
    };
    return () => props.contribution.error
      ? h('div', { class: 'plugin-error' }, [
          h('div', `plugin ${props.contribution.owner} UI crashed: ${props.contribution.error}`),
          h('button', { onClick: retry }, 'retry UI'),
        ])
      : h(props.contribution.component, {
          ...(props.contribution.props ?? {}),
          key: props.contribution.version,
          ref: props.contribution.stateRef,
        });
  },
});

export const UiContributionsHost = defineComponent({
  name: 'UiContributionsHost',
  props: { region: { type: String, default: 'main' } },
  setup(props: { region: string }) {
    const ui = useService<UiService>('ui');
    return () => [...(ui.value?.contributions.values() ?? [])]
      .filter(contribution => (contribution.region ?? 'main') === props.region)
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.id.localeCompare(b.id))
      .map(contribution => h(UiContributionHost, {
      key: `${contribution.id}:${contribution.version}`,
      contribution,
      }));
  },
});
