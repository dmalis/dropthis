#!/usr/bin/env node
// Generate PKCE code_verifier, code_challenge (S256), and state.
// Usage: node pkce.js
// Output: JSON with code_verifier, code_challenge, and state.

const crypto = require("crypto");

const codeVerifier = crypto.randomBytes(32).toString("base64url");
const codeChallenge = crypto
  .createHash("sha256")
  .update(codeVerifier)
  .digest("base64url");
const state = crypto.randomBytes(16).toString("base64url");

console.log(JSON.stringify({ code_verifier: codeVerifier, code_challenge: codeChallenge, state }));
