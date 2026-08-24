import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxComposer, shouldSubmitComposerKey } from '@/extension/sandbox-composer';

test('composer shortcut submits only outside IME composition', () => {
  assert.equal(shouldSubmitComposerKey({ key: 'Enter', ctrlKey: true }, false), true);
  assert.equal(shouldSubmitComposerKey({ key: 'Enter', ctrlKey: true, isComposing: true }, false), false);
  assert.equal(shouldSubmitComposerKey({ key: 'Enter', ctrlKey: true }, true), false);
  assert.equal(shouldSubmitComposerKey({ key: 'Enter', ctrlKey: false }, false), false);
});

test('composer exposes a real stop action while the loop is running', () => {
  assert.match(SandboxComposer.template!, /v-if="running"[^>]*@click="\$emit\('stop'\)"[^>]*>停止/);
  assert.match(SandboxComposer.template!, /v-else[^>]*@click="send"/);
});
