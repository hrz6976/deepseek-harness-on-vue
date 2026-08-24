import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchForUserScript,
  isUserScriptNetworkRequest,
  USER_SCRIPT_NETWORK_CHANNEL,
  withUserScriptNetwork,
} from '@/extension/user-script-network';

test('userscript source receives a fetch bridge without changing its source body', () => {
  const source = '(async () => { document.body.dataset.loaded = String((await fetch("https://api.example.test/data")).ok); })()';
  const wrapped = withUserScriptNetwork(source);
  assert.match(wrapped, /chrome\.runtime\.sendMessage/);
  assert.match(wrapped, /harness-userscript-network-v1/);
  assert.match(wrapped, /document\.body\.dataset\.loaded/);
  assert.doesNotThrow(() => new Function(wrapped));
});

test('userscript network requests are executed by the extension fetch context', async () => {
  let receivedUrl = '';
  let receivedInit: RequestInit | undefined;
  const message = {
    channel: USER_SCRIPT_NETWORK_CHANNEL,
    url: 'https://api.example.test/data',
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
  } as const;
  assert.equal(isUserScriptNetworkRequest(message), true);

  const result = await fetchForUserScript(message, async (input, init) => {
    receivedUrl = String(input);
    receivedInit = init;
    return new Response('{"saved":true}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  });

  assert.equal(receivedUrl, 'https://api.example.test/data');
  assert.equal(receivedInit?.method, 'POST');
  assert.deepEqual(result, {
    ok: true,
    value: {
      body: '{"saved":true}',
      headers: { 'content-type': 'application/json' },
      redirected: false,
      status: 201,
      statusText: '',
      url: '',
    },
  });
});
