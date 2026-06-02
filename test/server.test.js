const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../server');

function startServer() {
  const dbPath = path.join(
    os.tmpdir(),
    `config-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  );

  const server = createServer({ dbPath });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({
        port,
        dbPath,
        close: async () => {
          await new Promise((done, reject) => server.close((err) => (err ? reject(err) : done())));
          await server.closeStorage();
          if (fs.existsSync(dbPath)) {
            fs.unlinkSync(dbPath);
          }
        }
      });
    });
  });
}

test('stores and retrieves config and secret values', async (t) => {
  const app = await startServer();
  t.after(async () => app.close());

  let response = await fetch(`http://127.0.0.1:${app.port}/configs/appName`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'my-app' })
  });
  assert.equal(response.status, 200);

  response = await fetch(`http://127.0.0.1:${app.port}/configs/appName`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { key: 'appName', value: 'my-app' });

  response = await fetch(`http://127.0.0.1:${app.port}/secrets/apiKey`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'secret-token' })
  });
  assert.equal(response.status, 200);

  response = await fetch(`http://127.0.0.1:${app.port}/secrets/apiKey`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { key: 'apiKey', value: 'secret-token' });
});

test('returns 404 for missing keys', async (t) => {
  const app = await startServer();
  t.after(async () => app.close());

  const response = await fetch(`http://127.0.0.1:${app.port}/configs/missing`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Key not found' });
});

test('validates payload value type', async (t) => {
  const app = await startServer();
  t.after(async () => app.close());

  const response = await fetch(`http://127.0.0.1:${app.port}/secrets/token`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 123 })
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'value must be a string' });
});
