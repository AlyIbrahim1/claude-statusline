#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readCargoVersion(cargoTomlPath) {
  const content = fs.readFileSync(cargoTomlPath, 'utf8');
  const match = content.match(/^version\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

function main() {
  const root = path.resolve(__dirname, '..');
  const packageJsonPath = path.join(root, 'package.json');
  const packageLockPath = path.join(root, 'package-lock.json');
  const cargoTomlPath = path.join(root, 'Cargo.toml');
  const pluginJsonPath = path.join(root, '.claude-plugin', 'plugin.json');
  const marketplaceJsonPath = path.join(root, '.claude-plugin', 'marketplace.json');

  const rootPkg = readJson(packageJsonPath);
  const lock = readJson(packageLockPath);
  const cargoVersion = readCargoVersion(cargoTomlPath);
  const pluginJson = readJson(pluginJsonPath);
  const marketplaceJson = readJson(marketplaceJsonPath);
  const optionalDeps = rootPkg.optionalDependencies || {};

  const errors = [];
  const expected = rootPkg.version;

  if (!expected) {
    errors.push('package.json is missing a version');
  }

  if (!cargoVersion) {
    errors.push('Cargo.toml is missing a version');
  } else if (cargoVersion !== expected) {
    errors.push(`Cargo.toml version ${cargoVersion} does not match package.json version ${expected}`);
  }

  if (!pluginJson.version) {
    errors.push('.claude-plugin/plugin.json is missing a version');
  } else if (pluginJson.version !== expected) {
    errors.push(`.claude-plugin/plugin.json version ${pluginJson.version} does not match package.json version ${expected}`);
  }

  const marketplaceVersion = marketplaceJson.plugins && marketplaceJson.plugins[0] && marketplaceJson.plugins[0].version;
  if (!marketplaceVersion) {
    errors.push('.claude-plugin/marketplace.json is missing plugins[0].version');
  } else if (marketplaceVersion !== expected) {
    errors.push(`.claude-plugin/marketplace.json plugins[0].version ${marketplaceVersion} does not match package.json version ${expected}`);
  }

  for (const [name, version] of Object.entries(optionalDeps)) {
    const lockRootVersion = lock.packages && lock.packages[''] && lock.packages[''].optionalDependencies
      ? lock.packages[''].optionalDependencies[name]
      : undefined;
    if (lockRootVersion !== version) {
      errors.push(`package-lock.json root optionalDependencies[${name}] is ${lockRootVersion}, expected ${version}`);
    }
    // node_modules entries are only resolved once the package exists on npm.
    // Pre-publish they contain only { optional: true } — skip the version check in that case.
    const lockPkg = lock.packages && lock.packages[`node_modules/${name}`];
    if (lockPkg && lockPkg.version !== undefined && lockPkg.version !== version) {
      errors.push(`package-lock.json node_modules entry for ${name} is ${lockPkg.version}, expected ${version}`);
    }
  }

  if (errors.length > 0) {
    console.error('[check-versions] Failed version alignment checks:');
    for (const err of errors) {
      console.error(`- ${err}`);
    }
    process.exit(1);
  }

  console.log(`[check-versions] OK (version ${expected})`);
}

main();
