const http = require('node:http');
const { URL } = require('node:url');
const sqlite3 = require('sqlite3').verbose();

function createStorage(dbPath = 'config.db') {
  const db = new sqlite3.Database(dbPath);

  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS entries (
        type TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (type, key)
      )`
    );
  });

  return {
    set(type, key, value) {
      return new Promise((resolve, reject) => {
        db.run(
          'INSERT INTO entries (type, key, value) VALUES (?, ?, ?) ON CONFLICT(type, key) DO UPDATE SET value = excluded.value',
          [type, key, value],
          (err) => (err ? reject(err) : resolve())
        );
      });
    },
    get(type, key) {
      return new Promise((resolve, reject) => {
        db.get(
          'SELECT value FROM entries WHERE type = ? AND key = ?',
          [type, key],
          (err, row) => (err ? reject(err) : resolve(row ? row.value : null))
        );
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        db.close((err) => (err ? reject(err) : resolve()));
      });
    }
  };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function createServer({ dbPath = 'config.db' } = {}) {
  const storage = createStorage(dbPath);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const match = url.pathname.match(/^\/(configs|secrets)\/([^/]+)$/);

      if (!match) {
        sendJson(res, 404, { error: 'Not Found' });
        return;
      }

      const [, type, key] = match;
      const decodedKey = decodeURIComponent(key);

      if (req.method === 'GET') {
        const value = await storage.get(type, decodedKey);

        if (value === null) {
          sendJson(res, 404, { error: 'Key not found' });
          return;
        }

        sendJson(res, 200, { key: decodedKey, value });
        return;
      }

      if (req.method === 'PUT') {
        const body = await parseBody(req);

        if (typeof body.value !== 'string') {
          sendJson(res, 400, { error: 'value must be a string' });
          return;
        }

        await storage.set(type, decodedKey, body.value);
        sendJson(res, 200, { key: decodedKey, value: body.value });
        return;
      }

      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (err) {
      const statusCode = err.message === 'Invalid JSON body' ? 400 : 500;
      sendJson(res, statusCode, { error: err.message || 'Internal Server Error' });
    }
  });

  server.closeStorage = () => storage.close();
  return server;
}

module.exports = {
  createServer,
  createStorage
};

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const dbPath = process.env.CONFIG_DB_PATH || 'config.db';
  const server = createServer({ dbPath });

  server.listen(port, () => {
    console.log(`Config server listening on port ${port}`);
  });
}
