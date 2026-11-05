const vscode = require("vscode");
const { resolveKey, smokeChat } = require("./smoke");

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("hypermesh.smoke", async () => {
      const config = vscode.workspace.getConfiguration("hypermesh");
      try {
        const key = await resolveKey(context.secrets, () =>
          vscode.window.showInputBox({
            prompt: "Renter API key",
            password: true,
            ignoreFocusOut: true,
          })
        );
        const result = await smokeChat({
          apiBase: config.get("apiBase"),
          tenant: config.get("tenant"),
          key,
        });
        vscode.window.showInformationMessage(`Hypermesh smoke ok (${result.status})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Hypermesh smoke failed: ${message}`);
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
