// Unit test for the SPA rewrite CloudFront Function. Run: node --test (part of pnpm test:infra).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// CloudFront Functions are plain scripts with a global `handler`, no exports.
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("./spa-rewrite.js", import.meta.url), "utf8"), context);
const { handler } = context;

const rewrite = (uri) => handler({ request: { uri, method: "GET" } }).uri;

test("app routes are served index.html", () => {
  for (const uri of ["/", "/gallery", "/photos/01JABCDEF", "/albums/x/", "/auth/callback"]) {
    assert.equal(rewrite(uri), "/index.html", uri);
  }
});

test("files pass through unchanged", () => {
  for (const uri of ["/index.html", "/assets/index-abc123.js", "/sw.js", "/manifest.webmanifest"]) {
    assert.equal(rewrite(uri), uri, uri);
  }
});

test("the rest of the request is kept", () => {
  const request = { uri: "/gallery", method: "GET", querystring: { album: { value: "a" } } };
  assert.deepEqual(handler({ request }), { ...request, uri: "/index.html" });
});
