const http = require("node:http");

async function startObservabilityReceiver() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let json = null;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {}
      requests.push({ method: req.method, headers: req.headers, body, json });
      res.writeHead(202).end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/observability`,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startObservabilityReceiver };
