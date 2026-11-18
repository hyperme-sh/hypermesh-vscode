const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { args, exchange, label, tracking } = require('./continue');
function fixture(response, { code = 0, inspect = () => {} } = {}) {
 return (program, argv, options) => {
  const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin.end = input => { inspect({ program, argv, options, input }); queueMicrotask(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(response))); child.emit('exit', code); child.emit('close', code); }); };
  return child;
 };
}
const run = { id:'11111111-1111-4111-8111-111111111111',workspace:'/project',revision:7,state:'paused',continue_enabled:false,used_chunks:1,budgets:{chunks:2} };
test('workspace selection is an argument and cannot become a shell command', () => {
 assert.deepEqual(args('/installed/companion','/project/$(ignored)','status'), ['/installed/companion',['--continue-status-workspace','/project/$(ignored)']]);
 assert.throws(() => args('/installed/companion','relative','status'));
 assert.throws(() => args('/installed/companion','/project','shell'));
});
test('reconnect reads existing paused state without starting a task', async () => {
 const result = await exchange('/installed/companion','/project',null,fixture({run},{inspect(call){assert.equal(call.input,'');assert.equal(call.options.shell,false);assert.equal(call.argv[0],'--continue-status-workspace');}}));
 assert.equal(result.run.state,'paused');assert.match(label(result.run),/Continue off/);
});
test('controls retain the observed revision and require owner acknowledgement', async () => {
 const control = {run_id:run.id,revision:7,action:'continue-on'};
 const result = await exchange('/installed/companion','/project',control,fixture({run:{...run,revision:8,continue_enabled:true}},{inspect(call){assert.deepEqual(JSON.parse(call.input),control);assert.equal(call.argv[0],'--continue-control-workspace');}}));
 assert.equal(result.run.revision,8);
 await assert.rejects(exchange('/installed/companion','/project',control,fixture({}, {code:1})),/Refresh/);
});
test('wrong workspace, missing state and oversized responses are refused', async () => {
 for (const value of [{run:{...run,workspace:'/other'}},{}, {run:{...run,detail:'x'.repeat(140000)}}]) await assert.rejects(exchange('/installed/companion','/project',null,fixture(value)));
});
test('tracking links are bounded central issue PR and check URLs only', () => {
 assert.deepEqual(tracking({tracking:['https://github.com/hyperme-sh/visor/issues/265','https://github.com/hyperme-sh/visor/pull/313','https://evil.test/steal','https://github.com/a/b/issues/1?token=secret']}),['https://github.com/hyperme-sh/visor/issues/265','https://github.com/hyperme-sh/visor/pull/313']);
 assert.match(label({...run,state:'completed'}),/completed/);
 assert.match(label({...run,state:'external-blocker'}),/external-blocker/);
});
function editorFixture() {
 const commands = new Map(), selections = [], bar = { show(){},hide(){},dispose(){} };
 const context = { subscriptions:[] }; const dispose = () => context.subscriptions.forEach(v => v.dispose());
 const vscode = {
  StatusBarAlignment:{Left:1},
  window:{createStatusBarItem:()=>bar,activeTextEditor:{document:{uri:{scheme:'untitled'}}},onDidChangeActiveTextEditor:()=>({dispose(){}}),showQuickPick:async options=>{selections.push(options);return undefined;},showErrorMessage:message=>{throw Error(message);}},
  workspace:{isTrusted:true,workspaceFolders:[{uri:{scheme:'file',fsPath:'/project'}}],getWorkspaceFolder:()=>undefined,getConfiguration:()=>({inspect:()=>({globalValue:'/installed/companion'})}),onDidChangeWorkspaceFolders:()=>({dispose(){}})},
  commands:{registerCommand:(name,fn)=>{commands.set(name,fn);return {dispose(){}};}}
 };return {vscode,context,commands,selections,bar,dispose};
}
test('recovered unchanged owner state replaces reconnect warning', async () => {
 const f=editorFixture();let reads=0;
 const {install}=require('./continue');const client=install(f.vscode,f.context,async()=>{if(++reads===2)throw Error('offline');return {run};});
 try {await client.refresh();assert.match(f.bar.text,/Continue off/);await client.refresh();assert.match(f.bar.text,/reconnect/);await client.refresh();assert.match(f.bar.text,/Continue off/);} finally {f.dispose();}
});
test('task menu awaits initial refresh and works from an untitled chat answer', async () => {
 const f=editorFixture();let resolve;
 const {install}=require('./continue');install(f.vscode,f.context,(_executable,workspace)=>{assert.equal(workspace,'/project');return new Promise(r=>{resolve=r;});});
 try {const command=f.commands.get('hypermesh.continue')();await Promise.resolve();assert.equal(f.selections.length,0);resolve({run});await command;assert.ok(f.selections[0].includes('Pause'));assert.ok(f.selections[0].includes('Continue on'));} finally {f.dispose();}
});

test('successful exit waits for trailing stdout before acknowledging a control', async () => {
 const control = {run_id:run.id,revision:7,action:'pause'};
 const result = await exchange('/installed/companion','/project',control,() => {
  const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin.end = () => queueMicrotask(() => {
   child.stdout.emit('data', Buffer.from('{"run":'));
   child.emit('exit', 0);
   child.stdout.emit('data', Buffer.from(JSON.stringify(run) + '}'));
   child.emit('close', 0);
  });
  return child;
 });
 assert.deepEqual(result.run,run);
});
test('advice reads use a dedicated command without sending controls', async()=>{
 const advice={workspace:'/project',action:'checkpoint-compact',confidence:'medium',handoff:{goal:'Keep progress'}};
 const got=await exchange('/installed/companion','/project','advice',fixture(advice,{inspect(call){assert.equal(call.argv[0],'--continue-advice-workspace');assert.equal(call.input,'');}}));assert.deepEqual(got,advice);
 await assert.rejects(exchange('/installed/companion','/project','advice',fixture({...advice,workspace:'/other'})));
});
