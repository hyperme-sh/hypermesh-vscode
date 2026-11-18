const path = require('node:path');
const { spawn } = require('node:child_process');

// Only a user-selected installed executable receives a workspace selector.
// Native Visor rechecks the active assignment and current owner policy.
function managerArgs(executable, workspace) {
  for (const value of [executable, workspace]) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\r\n\0]/.test(value)) {
      throw new Error('Choose an installed companion and a local workspace.');
    }
  }
  return [executable, ['--permissions-workspace', workspace]];
}
function openManager(executable, workspace, spawnImpl = spawn) {
  const [program, args] = managerArgs(executable, workspace);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(program, args, { shell: false, windowsHide: true, stdio: 'ignore' });
    child.once('error', () => reject(new Error('Permission manager unavailable. Check the installed companion.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Permission manager did not complete. Reopen to refresh current workspace and policy.')));
  });
}
module.exports = { managerArgs, openManager };
