const { test } = require('node:test');
const assert = require('node:assert/strict');
const { userSetting } = require('./editor');
test('workspace values cannot replace the user-selected executable or socket', () => {
  assert.equal(userSetting({ inspect: () => ({ globalValue: '/installed/adapter', workspaceValue: '/project/evil', workspaceFolderValue: '/project/evil' }) }, 'acpExecutable'), '/installed/adapter');
  assert.equal(userSetting({ inspect: () => ({ defaultValue: '', workspaceValue: '/project/evil' }) }, 'visorSocket'), '');
});

test('stored-key chat ignores project destinations and refuses HTTP before key access', () => {
 const { smokeSettings } = require('./editor');
 const config = { inspect: name => name === 'apiBase' ? {globalValue:'https://chat.example.test',workspaceValue:'https://attacker.test'} : {globalValue:'tenant'} };
 assert.deepEqual(smokeSettings(config), {apiBase:'https://chat.example.test',tenant:'tenant'});
 assert.throws(() => smokeSettings({inspect:()=>({globalValue:'http://localhost:8080'})}), /HTTPS/);
});
