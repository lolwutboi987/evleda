#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const seedRelativeDirectory = 'resources/native-schematic-style-seed/v1';
export const manifestSha256 = '15ad8a960537b2ab00f8f2eda774d786cb7782edd39a16d0e67d6755c9e2cec1';
export const publicationFiles = Object.freeze({
  'manifest.json': manifestSha256,
  'README.md': '772be0ef0534465f727f2fce1d968bfc01a0df67ce549fd4349abea588119f32',
  'provenance/native-verification.json': 'fa277a6315e7d38dc22e9cfb05cb3181789afa4990027630d3e0fdb9496b0393',
});
export const sourceSeedDirectory = () => path.resolve(import.meta.dirname, '..', seedRelativeDirectory);
export const distSeedDirectory = () => path.resolve(import.meta.dirname, '..', 'dist', seedRelativeDirectory);
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function ordinary(entry, directory = false) {
  const stat = await lstat(entry);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || path.resolve(await realpath(entry)) !== path.resolve(entry)) {
    throw new Error(`Seed entry must be ordinary and canonical: ${entry}`);
  }
}
export async function verifyNativeSchematicStyleSeed(directory = sourceSeedDirectory(), { packaged = false } = {}) {
  directory = path.resolve(directory);
  await ordinary(directory, true);
  for (const [relative, expected] of Object.entries(publicationFiles)) {
    const file = path.join(directory, relative);
    await ordinary(file);
    if (hash(await readFile(file)) !== expected) throw new Error(`Seed publication hash differs: ${relative}`);
  }
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const expectedFiles = new Set(manifest.files.map(record => `config/${record.relativePath}`));
  const expectedDirectories = new Set(['config', ...manifest.configDirectories.map(name => `config/${name}`)]);
  const observedFiles = new Set();
  const observedDirectories = new Set();
  async function visit(relative) {
    const location = path.join(directory, relative);
    await ordinary(location, true);
    observedDirectories.add(relative);
    for (const entry of await readdir(location, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else { await ordinary(path.join(directory, child)); observedFiles.add(child); }
    }
  }
  await visit('config');
  if (observedFiles.size !== expectedFiles.size || [...observedFiles].some(name => !expectedFiles.has(name))
      || [...observedDirectories].some(name => !expectedDirectories.has(name))) throw new Error('Unexpected seed configuration topology');
  // Git does not retain empty directories. A source checkout may omit colors;
  // packaging and the runtime owner must materialize declared directories.
  for (const name of expectedDirectories) {
    if (!observedDirectories.has(name) && (packaged || name !== 'config/10.0/colors')) throw new Error(`Missing seed directory: ${name}`);
  }
  for (const record of manifest.files) {
    const bytes = await readFile(path.join(directory, 'config', record.relativePath));
    if (bytes.length !== record.sizeBytes || hash(bytes) !== record.sha256) throw new Error(`Seed template hash differs: ${record.relativePath}`);
    JSON.parse(bytes.toString('utf8'));
  }
  if (packaged) {
    const expected = new Set([...Object.keys(publicationFiles), ...expectedFiles]);
    const allowedDirs = new Set([...expectedDirectories, 'provenance']);
    async function inspect(relative = '') {
      for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await ordinary(path.join(directory, child), true);
          if (!allowedDirs.has(child)) throw new Error(`Unexpected packaged directory: ${child}`);
          await inspect(child);
        } else {
          await ordinary(path.join(directory, child));
          if (!expected.has(child)) throw new Error(`Unexpected packaged file: ${child}`);
        }
      }
    }
    await inspect();
  }
  return { manifest, manifestSha256, fileCount: manifest.files.length, templateBytes: manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--dist')) throw new Error('Usage: verify-native-schematic-style-seed.mjs [--dist]');
  const result = await verifyNativeSchematicStyleSeed(args.length ? distSeedDirectory() : sourceSeedDirectory(), { packaged: args.length > 0 });
  console.log(`Verified native schematic seed: ${result.fileCount} templates, ${result.templateBytes} bytes, manifest ${result.manifestSha256}`);
}
