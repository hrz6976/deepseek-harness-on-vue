import { computed, defineComponent, ref } from 'vue';
import { NButton, NIcon } from 'naive-ui';
import { Send } from '@vicons/tabler';

interface ComposerKeyEvent {
  key: string;
  ctrlKey: boolean;
  isComposing?: boolean;
}

export function shouldSubmitComposerKey(event: ComposerKeyEvent, compositionActive: boolean): boolean {
  return event.key === 'Enter' && event.ctrlKey && !event.isComposing && !compositionActive;
}

/**
 * The composer owns its draft so streaming timeline updates never patch the
 * textarea's value. Native textarea composition handling also keeps the DOM
 * value authoritative until the IME commits it.
 */
export const SandboxComposer = defineComponent({
  name: 'SandboxComposer',
  components: { NButton, NIcon, Send },
  props: {
    annotationCount: { type: Number, required: true },
    busy: { type: Boolean, required: true },
    runtimeReady: { type: Boolean, required: true },
  },
  emits: {
    send: (text: string) => typeof text === 'string',
    clearAnnotations: () => true,
  },
  setup(props, { emit }) {
    const draft = ref('');
    const compositionActive = ref(false);
    const canSend = computed(() => draft.value.trim().length > 0 || props.annotationCount > 0);

    function send(): void {
      if (compositionActive.value || props.busy || !props.runtimeReady || !canSend.value) return;
      const text = draft.value.trim();
      draft.value = '';
      emit('send', text);
    }

    function onKeydown(event: KeyboardEvent): void {
      if (!shouldSubmitComposerKey(event, compositionActive.value)) return;
      event.preventDefault();
      send();
    }

    return {
      draft,
      compositionActive,
      canSend,
      send,
      onKeydown,
      clearAnnotations: () => emit('clearAnnotations'),
    };
  },
  template: `
    <form class="composer" @submit.prevent="send">
      <div class="composer-field">
        <div v-if="annotationCount" class="annotation-context">
          <span>{{ annotationCount }} 个批注</span>
          <n-button text size="tiny" attr-type="button" @click="clearAnnotations">清除</n-button>
        </div>
        <textarea
          v-model="draft"
          class="composer-input"
          rows="2"
          placeholder="描述任务，或让 Harness 读取、分析和构建…"
          @compositionstart="compositionActive = true"
          @compositionend="compositionActive = false"
          @keydown="onKeydown"
        ></textarea>
        <div class="composer-footer">
          <span class="composer-hint">Ctrl Enter 发送</span>
          <n-button type="primary" size="small" attr-type="button" :loading="busy" :disabled="!runtimeReady || !canSend" @click="send">
            <template #icon><n-icon><Send /></n-icon></template>{{ !runtimeReady ? '初始化中' : busy ? '处理中' : '发送' }}
          </n-button>
        </div>
      </div>
    </form>
  `,
});
