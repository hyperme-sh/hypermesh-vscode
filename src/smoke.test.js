const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { completionsUrl, resolveKey, smokeChat } = require("./smoke");

const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const KEY = "pk_test.renter-key";

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("completions URL is the chat host, not the control-plane stub", () => {
  assert.equal(
    completionsUrl("https://chat.test.hyperme.sh"),
    "https://chat.test.hyperme.sh/v1/chat/completions"
  );
  assert.equal(
    completionsUrl("https://chat.test.hyperme.sh/v1"),
    "https://chat.test.hyperme.sh/v1/chat/completions"
  );
  assert.throws(
    () => completionsUrl("https://api.test.hyperme.sh/api/v1/hypermesh/renter/chat/completions"),
    /control-plane chat stub/
  );
});

test("smoke posts one short completion and fails unless status is 200 with a body", async () => {
  const seen = [];
  const server = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, tenant: req.headers["x-tenant-id"] });
      if (req.method === "GET" && req.url === "/api/v1/health/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"status":"Ok"}');
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const body = Buffer.concat(chunks).toString("utf8");
        assert.match(body, /ready/);
        assert.equal(req.headers.authorization, `Bearer ${KEY}`);
        assert.equal(req.headers["x-api-key"], undefined);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"choices":[{"message":{"content":"ready"}}]}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  try {
    const ok = await smokeChat({
      apiBase: server.base,
      tenant: TENANT,
      key: KEY,
    });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /ready/);
    assert.deepEqual(seen.map((row) => `${row.method} ${row.url}`), ["POST /v1/chat/completions"]);
    assert.equal(seen[0].tenant, TENANT);
  } finally {
    await server.close();
  }
});

test("a healthy edge GET is not a successful smoke", async () => {
  const server = await listen((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"Ok"}');
      return;
    }
    res.writeHead(502);
    res.end();
  });
  try {
    await assert.rejects(
      () => smokeChat({ apiBase: server.base, tenant: TENANT, key: KEY }),
      /smoke failed: status 502/
    );
  } finally {
    await server.close();
  }
});

test("an empty 200 body fails", async () => {
  const server = await listen((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("  ");
  });
  try {
    await assert.rejects(
      () => smokeChat({ apiBase: server.base, tenant: TENANT, key: KEY }),
      /smoke failed: status 200/
    );
  } finally {
    await server.close();
  }
});

test("the command title is Hypermesh: smoke", () => {
  const pkg = require("../package.json");
  const command = pkg.contributes.commands.find((row) => row.command === "hypermesh.smoke");
  assert.equal(command.title, "Hypermesh: smoke");
  assert.equal(pkg.contributes.configuration.properties["hypermesh.apiBase"].default, "https://chat.test.hyperme.sh");
  assert.ok(pkg.contributes.configuration.properties["hypermesh.tenant"]);
  assert.equal(pkg.contributes.configuration.properties["hypermesh.key"], undefined);
});

test("the renter key is reused from secret storage", async () => {
  let prompted = false;
  const key = await resolveKey(
    { get: async () => KEY, store: async () => {} },
    async () => {
      prompted = true;
      return "should-not-prompt";
    }
  );
  assert.equal(key, KEY);
  assert.equal(prompted, false);
});

test("a missing secret is prompted once and stored", async () => {
  const stored = [];
  const key = await resolveKey(
    {
      get: async () => "",
      store: async (name, value) => stored.push([name, value]),
    },
    async () => KEY
  );
  assert.equal(key, KEY);
  assert.deepEqual(stored, [["hypermesh.key", KEY]]);
});
