#!/usr/bin/env node
// Local OAuth callback server for MCP OAuth flow.
// Usage: node callback_server.js [port]
// Captures the authorization code from the OAuth redirect and writes it to /tmp/mcp_oauth_code.txt.

const http = require("http");
const fs = require("fs");

const port = parseInt(process.argv[2] || "9999", 10);

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/callback")) {
    const params = new URL(req.url, `http://localhost:${port}`).searchParams;
    const code = params.get("code") || "";
    const state = params.get("state") || "";

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<h1>Authorization successful!</h1><p>You can close this tab.</p>"
    );

    fs.writeFileSync("/tmp/mcp_oauth_code.txt", code);
    fs.writeFileSync("/tmp/mcp_oauth_state.txt", state);
    console.log(`CODE=${code}`);
    console.log(`STATE=${state}`);
    server.close();
  }
});

server.listen(port, "localhost", () => {
  console.log(`Listening on http://localhost:${port}/callback ...`);
});
