const { test } = require('node:test');
const assert = require('node:assert/strict');
const { userSetting } = require('./editor');
test('workspace values cannot replace the user-selected executable or socket', () => {
  assert.equal(userSetting({ inspect: () => ({ globalValue: '/installed/adapter', workspaceValue: '/project/evil', workspaceFolderValue: '/project/evil' }) }, 'acpExecutable'), '/installed/adapter');
  assert.equal(userSetting({ inspect: () => ({ defaultValue: '', workspaceValue: '/project/evil' }) }, 'visorSocket'), '');
});
