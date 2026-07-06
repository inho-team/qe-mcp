#!/usr/bin/env node
// CI gate: fail if any in-tree expert SKILL.md body exceeds the size limit.
// Guards against oversized experts bloating the payload or the read path.
// The extra pack ships and gates its own experts separately.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// QE_SIZE_PACKS_ROOT lets the selftest point the gate at a fixture tree.
const PACKS_ROOT = process.env.QE_SIZE_PACKS_ROOT
  ? resolve(process.env.QE_SIZE_PACKS_ROOT)
  : join(REPO_ROOT, 'expert-library', 'packs');
const MAX_BODY_BYTES = 51200; // 50 KiB per expert body

function collectSkillFiles() {
  const files = [];
  if (!existsSync(PACKS_ROOT)) return files;
  for (const pack of readdirSync(PACKS_ROOT)) {
    const skillsDir = join(PACKS_ROOT, pack, 'skills');
    if (!existsSync(skillsDir)) continue;
    for (const name of readdirSync(skillsDir)) {
      const skillMd = join(skillsDir, name, 'SKILL.md');
      if (existsSync(skillMd) && statSync(skillMd).isFile()) files.push(skillMd);
    }
  }
  return files;
}

function main() {
  const files = collectSkillFiles();
  const violations = [];
  for (const file of files) {
    const bytes = Buffer.byteLength(readFileSync(file, 'utf8'), 'utf8');
    if (bytes > MAX_BODY_BYTES) {
      violations.push({ file: relative(REPO_ROOT, file).split('\\').join('/'), bytes });
    }
  }
  if (violations.length > 0) {
    console.error(`expert size gate FAILED: ${violations.length} file(s) exceed ${MAX_BODY_BYTES} bytes (50 KiB):`);
    for (const v of violations.sort((a, b) => b.bytes - a.bytes)) {
      console.error(`  ${(v.bytes / 1024).toFixed(1)} KiB  ${v.file}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`expert size gate ok: ${files.length} experts, all <= ${MAX_BODY_BYTES} bytes (50 KiB)`);
}

main();
