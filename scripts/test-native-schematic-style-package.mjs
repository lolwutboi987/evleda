#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { packageNativeSchematicStyleSeed } from './package-native-schematic-style-seed.mjs';
import { hash, manifestSha256, seedRelativeDirectory, sourceSeedDirectory, verifyNativeSchematicStyleSeed } from './verify-native-schematic-style-seed.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'evleda-native-style-package-'));
const originalCwd = process.cwd();
try {
  const sourceTree = path.join(temporary, 'source');
  const source = path.join(sourceTree, seedRelativeDirectory);
  await cp(sourceSeedDirectory(), source, { recursive: true });
  // Simulate a fresh checkout: no untracked empty colors directory.
  await rm(path.join(source, 'config', '10.0', 'colors'), { recursive: true, force: true });
  const verified = await verifyNativeSchematicStyleSeed(source);
  assert.equal(verified.fileCount, 8);
  assert.equal(verified.templateBytes, 62918);
  assert.equal(verified.manifestSha256, manifestSha256);
  const dist = path.join(temporary, 'relocated', 'dist');
  const packaged = await packageNativeSchematicStyleSeed(source, dist);
  assert.equal(packaged, path.join(dist, seedRelativeDirectory));
  await verifyNativeSchematicStyleSeed(packaged, { packaged: true });
  assert.deepEqual(await readdir(path.join(packaged, 'config', '10.0', 'colors')), []);
  assert.deepEqual((await readdir(packaged)).sort(), ['README.md', 'config', 'manifest.json', 'provenance']);
  assert.deepEqual(await readdir(path.join(packaged, 'provenance')), ['native-verification.json']);

  // Exercise the actual two CLI producer functions, transpiled without the CLI
  // entrypoint and unrelated workflow. Filesystem helpers below are test seams;
  // this is not a full compiled-CLI or native export integration test.
  const cliText = await readFile(path.join(root, 'src', 'cli', 'pcb-agent.ts'), 'utf8');
  const ast = ts.createSourceFile('pcb-agent.ts', cliText, ts.ScriptTarget.Latest, true);
  const names = new Set(['materializeNativeSchematicStyleContext', 'prepareOwnedNativeSchematicStyleSeed']);
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
  assert.equal(functions.length, 2, 'CLI producer functions must remain available');
  const seams = `
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
const readBoundedOrdinaryFile = async (file, limit) => { const bytes = await readFile(file); if(bytes.length > limit) throw new Error('bound'); return bytes; };
const parsePortableJsonBytes = bytes => JSON.parse(bytes.toString('utf8'));
const contentIdentity = bytes => ({ size: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') });
const canonicalJson = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b]) => a.localeCompare(b))) : item);
const isPathWithin = (parent, child) => { const relative = path.relative(parent, child); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); };
`;
  const producerText = seams + ts.transpileModule(functions.map(node => node.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText
    + '\nexport { prepareOwnedNativeSchematicStyleSeed };\n';
  const cleanCwd = path.join(temporary, 'clean-cwd');
  await mkdir(cleanCwd);
  process.chdir(cleanCwd);
  for (const [label, tree] of [['source', sourceTree], ['dist', dist]]) {
    const module = path.join(tree, 'src', 'cli', 'pcb-agent.js');
    await mkdir(path.dirname(module), { recursive: true });
    await writeFile(path.join(tree, 'package.json'), '{"type":"module"}\n');
    await writeFile(module, producerText);
    const producer = await import(pathToFileURL(module).href);
    const output = path.join(temporary, `${label}-owned`);
    const cwd = path.join(output, 'project');
    await mkdir(cwd, { recursive: true });
    const cli = path.join(temporary, 'approved', 'bin', 'kicad-cli.exe');
    const result = await producer.prepareOwnedNativeSchematicStyleSeed(output, cwd, { path: cli });
    assert.equal(result.templateManifestIdentity.digest, manifestSha256);
    for (const dir of verified.manifest.configDirectories) assert.deepEqual((await readdir(path.join(result.configHome, dir))).sort(), dir.endsWith('/colors') ? [] : [...verified.manifest.files.map(file => path.basename(file.relativePath)), 'colors'].sort());
    assert.deepEqual(await readdir(path.join(result.cacheHome, 'KiCad', '10.0')), []);
    for (const file of verified.manifest.files) {
      const actual = await readFile(path.join(result.configHome, file.relativePath));
      const template = await readFile(path.join(source, 'config', file.relativePath));
      const expected = file.relativePath.endsWith('/kicad_common.json')
        ? Buffer.from(template.toString('utf8').replace('"interpreter_path": ""', '"interpreter_path": ' + JSON.stringify(path.join(path.dirname(cli), 'pythonw.exe'))).replace('"working_dir": ""', '"working_dir": ' + JSON.stringify(cwd))) : template;
      assert.equal(hash(actual), hash(expected), `${label}: exact owned bytes ${file.relativePath}`);
    }
  }
  const damaged = path.join(packaged, 'config', '10.0', 'eeschema.json');
  await writeFile(damaged, '{}');
  await assert.rejects(verifyNativeSchematicStyleSeed(packaged, { packaged: true }), /template hash differs/);
  await packageNativeSchematicStyleSeed(source, dist);
  await writeFile(path.join(packaged, 'candidate-manifest.json'), '{}');
  await assert.rejects(verifyNativeSchematicStyleSeed(packaged, { packaged: true }), /Unexpected packaged file/);
  await packageNativeSchematicStyleSeed(source, dist);
  await rm(path.join(packaged, 'config', '10.0', 'colors'), { recursive: true });
  await assert.rejects(verifyNativeSchematicStyleSeed(packaged, { packaged: true }), /Missing seed directory/);
  await packageNativeSchematicStyleSeed(source, dist);
  const changedRecipe = structuredClone(verified.manifest);
  changedRecipe.materialization.preserveOtherBytes = false;
  await writeFile(path.join(packaged, 'manifest.json'), JSON.stringify(changedRecipe));
  await assert.rejects(verifyNativeSchematicStyleSeed(packaged, { packaged: true }), /publication hash differs/);
  console.log('Native schematic seed packaging passed: fresh-checkout source, relocated dist, actual producer functions, exact eight-file bytes/materialization, required empty directories, and corruption/shadow/missing-directory rejection. No native export.');
} finally {
  process.chdir(originalCwd);
  if (path.dirname(temporary) !== path.resolve(tmpdir()) || !path.basename(temporary).startsWith('evleda-native-style-package-')) throw new Error('Unexpected cleanup target');
  await rm(temporary, { recursive: true, force: true });
}
