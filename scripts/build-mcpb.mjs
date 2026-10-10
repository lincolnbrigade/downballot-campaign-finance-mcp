#!/usr/bin/env node
// Build the Desktop Extension bundle (.mcpb) that the Claude desktop app installs
// with one click. It is a zip with manifest.json at its root plus the files the
// server needs. Run from the repo root:  node scripts/build-mcpb.mjs
// The version comes from manifest.json; keep it equal to the server's own.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const server = fs.readFileSync(path.join(ROOT, "servers/jurisdiction/index.js"), "utf8");
const serverVersion = server.match(/const SERVER_VERSION = "([^"]+)"/)?.[1];
if (serverVersion !== manifest.version) {
  console.error(`manifest.json says ${manifest.version} but the server says ${serverVersion}. Make them match first.`);
  process.exit(1);
}
const files = ["manifest.json", "LICENSE", "README.md", "servers/jurisdiction/index.js", "servers/jurisdiction/sources.json", "servers/jurisdiction/package.json"];
for (const f of files) if (!fs.existsSync(path.join(ROOT, f))) throw new Error(`missing ${f}`);
const outDir = path.join(ROOT, "dist");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${manifest.name}-${manifest.version}.mcpb`);
fs.rmSync(out, { force: true });
// zip is on every Mac and most Linux boxes; -X leaves out extra file attributes.
execFileSync("zip", ["-X", "-q", out, ...files], { cwd: ROOT, stdio: "inherit" });
console.log(`built ${path.relative(ROOT, out)} (${fs.statSync(out).size} bytes)`);
