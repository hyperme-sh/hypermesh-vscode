/**
 * One short completion on the chat host.
 * Headless: the VS Code command, `node --test`, and the GitHub Action all call this.
 * GET /api/v1/health/ is not success. The control-plane chat stub is refused.
 * The renter key is a SecretStorage value, not a workspace setting.
 */

const STUB_PATH = "/api/v1/hypermesh/renter/chat/completions";
const MESSAGE = "Reply with the single word ready.";
const SECRET_KEY = "hypermesh.key";

function completionsUrl(apiBase) {
  const root = String(apiBase || "").trim().replace(/\/+$/, "");
  if (!root) {
    throw new Error("API base is required");
  }
  if (root.includes(STUB_PATH)) {
    throw new Error("refusing the control-plane chat stub");
  }
  const url = root.endsWith("/v1") ? `${root}/chat/completions` : `${root}/v1/chat/completions`;
  if (url.includes(STUB_PATH)) {
    throw new Error("refusing the control-plane chat stub");
  }
  return url;
}

async function resolveKey(secrets, prompt) {
  const stored = String((await secrets.get(SECRET_KEY)) || "").trim();
  if (stored) {
    return stored;
  }
  const entered = String((await prompt()) || "").trim();
  if (!entered) {
    throw new Error("API key is required");
  }
  await secrets.store(SECRET_KEY, entered);
  return entered;
}

async function smokeChat({ apiBase, tenant, key, fetchImpl } = {}) {
  const tenantId = String(tenant || "").trim();
  const apiKey = String(key || "").trim();
  if (!tenantId) {
    throw new Error("tenant is required");
  }
  if (!apiKey) {
    throw new Error("API key is required");
  }
  const url = completionsUrl(apiBase);
  const fetchFn = fetchImpl || fetch;
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Tenant-ID": tenantId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [{ role: "user", "content": MESSAGE }],
      max_tokens: 8,
    }),
  });
  const body = await response.text();
  if (response.status !== 200 || !String(body).trim()) {
    const error = new Error(`smoke failed: status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return { status: response.status, body };
}

module.exports = { completionsUrl, resolveKey, smokeChat, MESSAGE, SECRET_KEY, STUB_PATH };
