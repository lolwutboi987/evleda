#!/usr/bin/env node
import { copyFile, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicationFiles, seedRelativeDirectory, sourceSeedDirectory, verifyNativeSchematicStyleSeed } from './verify-native-schematic-style-seed.mjs';

export async function packageNativeSchematicStyleSeed(source = sourceSeedDirectory(), distRoot = path.resolve(import.meta.dirname, '..', 'dist')) {
  distRoot = path.resolve(distRoot);
  const target = path.resolve(distRoot, seedRelativeDirectory);
  const relative = path.relative(distRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Seed package target escapes dist');
  const verified = await verifyNativeSchematicStyleSeed(source);
  // Reject linked ancestors before replacing the exact, narrowly owned target.
  for (let parent = target; ; parent = path.dirname(parent)) {
    try { if ((await lstat(parent)).isSymbolicLink()) throw new Error(`Linked package ancestor: ${parent}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (parent === path.dirname(parent)) break;
  }
  if (path.resolve(source) === target || path.resolve(source).startsWith(`${target}${path.sep}`) || target.startsWith(`${path.resolve(source)}${path.sep}`)) throw new Error('Seed source overlaps package target');
  await rm(target, { recursive: true, force: true });
  for (const directory of ['config', 'provenance', ...verified.manifest.configDirectories.map(name => `config/${name}`)]) {
    await mkdir(path.join(target, directory), { recursive: true });
  }
  for (const relativeFile of [...Object.keys(publicationFiles), ...verified.manifest.files.map(record => `config/${record.relativePath}`)]) {
    await copyFile(path.join(source, relativeFile), path.join(target, relativeFile));
  }
  await verifyNativeSchematicStyleSeed(target, { packaged: true });
  return target;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) throw new Error('Usage: package-native-schematic-style-seed.mjs');
  console.log(`Packaged native schematic seed at ${await packageNativeSchematicStyleSeed()}`);
}
