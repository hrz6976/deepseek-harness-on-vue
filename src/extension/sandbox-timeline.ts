import { computed, nextTick, onMounted, onUnmounted, ref, watch, watchEffect, type Ref } from 'vue';
import type { Annotation } from '@/shared/page-protocol';
import type { HarnessMessage } from '@/shared/runtime';
import { shouldDisplayMessage } from './message-presentation';
import { isNearScrollBottom, nextScrollFollowState } from './scroll-follow';

interface TimelineEntry {
  id: string;
  kind: 'user' | 'agent' | 'event' | 'error';
  text: string;
}

type DisplayBlock =
  | { id: string; type: 'message'; message: HarnessMessage; annotations?: readonly Annotation[] }
  | { id: string; type: 'timeline'; item: TimelineEntry };

const displayFeed = ref<DisplayBlock[]>([]);
const seenMessages = new WeakSet<object>();

export function appendTimeline(kind: TimelineEntry['kind'], text: string): void {
  const item: TimelineEntry = { id: crypto.randomUUID(), kind, text };
  displayFeed.value.push({ id: item.id, type: 'timeline', item });
}

export function displayMessageText(message: HarnessMessage): string {
  if (message.role === 'assistant') return message.text || (message.status === 'streaming' ? '…' : '');
  if (message.role === 'note' && message.text.startsWith('LLM call failed:')) {
    return `请求失败：${message.text.slice('LLM call failed:'.length).trim()}`;
  }
  return message.text;
}

export function useTimelineView(
  messages: () => readonly HarnessMessage[],
  activeTaskId: () => string | null | undefined,
  pendingAnnotations: Ref<readonly Annotation[]>,
) {
  const element = ref<HTMLElement | null>(null);
  const following = ref(true);
  let frame: number | null = null;
  let pointerActive = false;
  let discreteScrollIntent = false;
  let lastScrollTop = 0;
  let mutationObserver: MutationObserver | null = null;
  let resizeObserver: ResizeObserver | null = null;

  function schedule(force = false): void {
    if ((!force && !following.value) || frame != null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      if (!element.value || (!force && !following.value)) return;
      element.value.scrollTop = element.value.scrollHeight;
      lastScrollTop = element.value.scrollTop;
      following.value = true;
    });
  }
  function pause(): void {
    following.value = false;
    if (frame == null) return;
    window.cancelAnimationFrame(frame);
    frame = null;
  }
  function resume(): void {
    following.value = true;
    void nextTick(() => schedule(true));
  }
  function onScroll(): void {
    if (!element.value) return;
    const scrollTop = element.value.scrollTop;
    const next = nextScrollFollowState({
      following: following.value,
      previousScrollTop: lastScrollTop,
      metrics: element.value,
      userDriven: pointerActive || discreteScrollIntent,
    });
    if (!next) pause();
    else if (!following.value) resume();
    lastScrollTop = scrollTop;
    discreteScrollIntent = false;
  }
  function onWheel(event: WheelEvent): void {
    discreteScrollIntent = true;
    if (event.deltaY < 0) pause();
    else if (!following.value && element.value && isNearScrollBottom(element.value)) resume();
  }
  function onKeydown(event: KeyboardEvent): void {
    const backward = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey);
    const forward = ['ArrowDown', 'PageDown', 'End'].includes(event.key) || (event.key === ' ' && !event.shiftKey);
    if (!backward && !forward) return;
    discreteScrollIntent = true;
    if (backward) pause();
  }
  const beginPointerScroll = () => { pointerActive = true; };
  const endPointerScroll = () => { pointerActive = false; };
  onMounted(() => {
    if (!element.value) return;
    mutationObserver = new MutationObserver(() => schedule());
    mutationObserver.observe(element.value, { childList: true, characterData: true, subtree: true });
    resizeObserver = new ResizeObserver(() => schedule());
    resizeObserver.observe(element.value);
    lastScrollTop = element.value.scrollTop;
    window.addEventListener('pointerup', endPointerScroll);
    window.addEventListener('pointercancel', endPointerScroll);
    window.addEventListener('blur', endPointerScroll);
    resume();
  });
  onUnmounted(() => {
    if (frame != null) window.cancelAnimationFrame(frame);
    window.removeEventListener('pointerup', endPointerScroll);
    window.removeEventListener('pointercancel', endPointerScroll);
    window.removeEventListener('blur', endPointerScroll);
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
  });
  watch(activeTaskId, taskId => {
    if (!taskId) return;
    resume();
    displayFeed.value.splice(0);
  }, { immediate: true, flush: 'sync' });
  watchEffect(() => {
    for (const message of messages()) {
      if (seenMessages.has(message)) continue;
      seenMessages.add(message);
      const annotations = message.role === 'user' && pendingAnnotations.value.length
        ? pendingAnnotations.value : undefined;
      displayFeed.value.push({ id: crypto.randomUUID(), type: 'message', message, annotations });
      if (annotations) pendingAnnotations.value = [];
    }
  }, { flush: 'sync' });

  return {
    timelineEl: element,
    followTimeline: following,
    onTimelineScroll: onScroll,
    onTimelineWheel: onWheel,
    beginTimelinePointerScroll: beginPointerScroll,
    onTimelineKeydown: onKeydown,
    resumeTimelineFollow: resume,
    displayBlocks: computed(() => displayFeed.value.filter(block =>
      block.type === 'timeline' || shouldDisplayMessage(block.message))),
  };
}
