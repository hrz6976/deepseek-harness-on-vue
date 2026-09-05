import type { Context, Plugin } from '@deepseek-ai/cordis';
import { reactive, ref } from 'vue';
import { isContextOverflow } from '@earendil-works/pi-ai';
import { errorMessage, log, modelLimitsFor, normalizeSessionLlmConfig } from '@/sdk';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { HarnessMessage } from '@/shared/runtime';
import { DEFAULT_SETTINGS, estimateContextTokens, runCompaction, compactionThreshold } from './compaction/algorithm';

export { DEFAULT_SETTINGS, estimateMessageTokens, estimateContextTokens, findCutIndex, serializeTranscript, runCompaction, compactionThreshold } from './compaction/algorithm';

export default {
  name: 'compaction',
  apply(ctx: Context): void {
    const settings = reactive({ ...DEFAULT_SETTINGS });
    const compacting = ref(false);
    const getLlm = () => ctx.get('llm');
    const getTask = () => ctx.get('task');
    const sessionConfig = () => getTask()?.activeTask()?.llm;
    const currentLimits = () => getLlm()?.limits(sessionConfig())
      ?? modelLimitsFor(normalizeSessionLlmConfig(sessionConfig()).model);
    const note = (messages: HarnessMessage[], text: string): void => { messages.push({ role: 'note', text }); };

    async function compact(messages: HarnessMessage[], signal = new AbortController().signal): Promise<boolean> {
      const llm = getLlm();
      if (!llm || compacting.value) return false;
      const task = getTask();
      compacting.value = true;
      try {
        const before = estimateContextTokens(messages);
        const did = await runCompaction(messages, { llm, settings, signal, sessionConfig: task?.activeTask()?.llm });
        if (did) {
          const after = estimateContextTokens(messages);
          note(messages, `上下文已压缩：约 ${Math.round(before / 1000)}k → ${Math.round(after / 1000)}k tokens`);
          log(`compaction: ~${before} → ~${after} est. tokens`);
        }
        return did;
      } finally { compacting.value = false; }
    }

    // Auto-trigger between turns, before the loop assembles the next request.
    // Failure falls through uncompacted — worst case the request overflows,
    // which the loop/llm-error hook below then catches.
    ctx.on('loop/turn-start', async (arg, next) => {
      const llm = getLlm();
      if (settings.enabled && llm) {
        if (estimateContextTokens(arg.messages) > compactionThreshold(currentLimits(), settings.safetyTokens)) {
          note(arg.messages, '上下文接近上限，正在压缩…');
          try { await compact(arg.messages, arg.signal); }
          catch (error: unknown) { note(arg.messages, `compaction failed: ${errorMessage(error)} — continuing uncompacted`); }
        }
      }
      return next(arg);
    });

    // Provider rejected the request as too long (estimate was off, or another
    // plugin inflated the request): compact and ask the loop for its one retry.
    ctx.on('loop/llm-error', async (arg, next) => {
      const overflowMessage = { role: 'assistant', stopReason: 'error', errorMessage: arg.message } as unknown as AssistantMessage;
      if (settings.enabled && isContextOverflow(overflowMessage)) {
        try {
          if (await compact(arg.messages, arg.signal)) {
            arg.retry = true;
            return next(arg);
          }
        }
        catch (error: unknown) { log(`compaction after overflow failed: ${errorMessage(error)}`, 'err'); }
      }
      return next(arg);
    });

    ctx.provide('compaction', {
      settings, compacting,
      contextTokens: estimateContextTokens,
      contextWindow: () => currentLimits().contextWindow,
      // manual "Compact" from the UI; loop must be idle (the button enforces it)
      async compact() {
        const task = getTask();
        if (!task || !getLlm()) return false;
        try { return await compact(task.messages); }
        catch (error: unknown) { note(task.messages, `compaction failed: ${errorMessage(error)}`); return false; }
      },
    });
    ctx.effect(() => () => log('compaction plugin unmounted', 'warn'), 'compaction.log-dispose');
  },
} satisfies Plugin.Object;
