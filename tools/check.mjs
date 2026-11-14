import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = "D:/opencode/meta-ads-clone";
const EXT = join(ROOT, "extension");
const problems = [];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const files = walk(EXT);
const jsFiles = files.filter((file) => file.endsWith(".js"));
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));

// 1. every path the manifest points at must exist
const referenced = new Set();
referenced.add(manifest.background.service_worker);
referenced.add(manifest.action.default_popup);
referenced.add(manifest.options_page);
for (const icon of Object.values(manifest.action.default_icon)) referenced.add(icon);
for (const icon of Object.values(manifest.icons)) referenced.add(icon);
for (const entry of manifest.content_scripts) for (const script of entry.js) referenced.add(script);
for (const path of referenced) {
  if (!existsSync(join(EXT, path))) problems.push(`manifest path missing: ${path}`);
}

// 2. syntax check every module
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    problems.push(`syntax: ${relative(EXT, file)}\n${error.stderr?.toString() ?? error.message}`);
  }
}

// 3. relative imports must resolve
for (const file of jsFiles) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(file), match[1]);
    if (!existsSync(target)) problems.push(`import missing: ${relative(EXT, file)} -> ${match[1]}`);
  }
}

// 4. enhancement list sanity
const enhancements = readFileSync(join(EXT, "src/enhancements.js"), "utf8");
const keys = [...enhancements.matchAll(/\{\s*key:\s*'([^']+)',\s*when:\s*'([^']+)'/g)].map((match) => ({
  key: match[1],
  when: match[2],
}));
const seen = new Set();
for (const { key } of keys) {
  if (seen.has(key)) problems.push(`duplicate enhancement key: ${key}`);
  seen.add(key);
}
const active = keys.filter((row) => row.when !== "never");
if (active.length !== 82) problems.push(`expected 82 active enhancement keys, found ${active.length}`);

// 5. element ids referenced from UI scripts must exist in their page
const dynamicIds = new Set(['placementError']);
for (const script of ['ui/popup.js', 'ui/options.js']) {
  const scriptPath = join(EXT, script);
  const pagePath = scriptPath.replace(/\.js$/, '.html');
  const scriptText = readFileSync(scriptPath, 'utf8');
  const pageText = readFileSync(pagePath, 'utf8');
  const pageIds = new Set([...pageText.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const used = new Set([
    ...[...scriptText.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]),
    ...[...scriptText.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]),
  ]);
  for (const id of used) {
    if (!pageIds.has(id) && !dynamicIds.has(id)) problems.push(`${script}: missing element #${id}`);
  }
}

// 6. quick inventory
const totalBytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
console.log(`extension files: ${files.length} (${jsFiles.length} js), ${(totalBytes / 1024).toFixed(1)} KiB`);
console.log(`enhancement keys: ${active.length} active, ${keys.length - active.length} guarded`);
console.log(problems.length ? `\nFAIL\n${problems.join("\n")}` : "\nOK: manifest, syntax, imports and enhancement list all check out.");
process.exit(problems.length ? 1 : 0);
