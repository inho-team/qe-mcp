#!/usr/bin/env node

import { existsSync } from 'fs';
import {
  defaultRegistry,
  getClientConfigPaths,
  getDefaultRegistryPath,
  readRegistry,
  syncRegistryToClients,
  writeRegistry,
} from './lib/qe_mcp_registry.mjs';
import {
  readExpert,
  recommendExpert,
  searchExperts,
} from './lib/qe_expert_library.mjs';

function printUsage() {
  console.log(`Usage:
  qe-mcp init-registry [--registry path] [--force]
  qe-mcp doctor [--registry path] [--json]
  qe-mcp sync [--registry path] [--client claude|codex|gemini|all] [--dry-run]
  qe-mcp expert search <query...> [--limit n] [--json]
  qe-mcp expert recommend <task...> [--client name] [--limit n] [--json]
  qe-mcp expert read <name> [--json]

Notes:
  - The registry is global by default: ~/.qe/mcp/registry.json
  - sync writes client-specific MCP configuration files
  - the default server is qeExpertLibrary`);
}

function parseArgs(argv) {
  const options = {
    registry: getDefaultRegistryPath(),
    force: false,
    json: false,
    dryRun: false,
    client: 'all',
    limit: undefined,
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--registry') {
      options.registry = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--client') {
      options.client = argv[index + 1] || options.client;
      index += 1;
      continue;
    }
    if (token === '--limit') {
      options.limit = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--force') {
      options.force = true;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    positionals.push(token);
  }

  return { options, positionals };
}

function normalizeClients(client) {
  return client === 'all' ? ['claude', 'codex', 'gemini'] : [client];
}

function printJsonOrText(payload, json, renderText) {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(renderText(payload));
}

async function main() {
  const { options, positionals } = parseArgs(process.argv.slice(2));
  const command = positionals[0];

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  if (command === 'init-registry') {
    const defaults = defaultRegistry();
    if (existsSync(options.registry) && !options.force) {
      const current = readRegistry(options.registry);
      writeRegistry(options.registry, {
        ...current,
        version: defaults.version,
        servers: {
          ...(current.servers || {}),
          qeExpertLibrary: defaults.servers.qeExpertLibrary,
        },
      });
      console.log(`Updated QE MCP registry: ${options.registry}`);
      return;
    }
    writeRegistry(options.registry, defaults);
    console.log(`Initialized QE MCP registry: ${options.registry}`);
    return;
  }

  if (command === 'doctor') {
    const registry = readRegistry(options.registry);
    const report = {
      registry_path: options.registry,
      registry_exists: existsSync(options.registry),
      servers: Object.keys(registry.servers || {}),
      client_paths: getClientConfigPaths(),
    };
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`Registry: ${report.registry_path}`);
    console.log(`Exists: ${report.registry_exists}`);
    console.log(`Servers: ${report.servers.join(', ') || 'none'}`);
    for (const [name, value] of Object.entries(report.client_paths)) {
      console.log(`${name}: ${value}`);
    }
    return;
  }

  if (command === 'sync') {
    const result = syncRegistryToClients({
      registryPath: options.registry,
      clients: normalizeClients(options.client),
      dryRun: options.dryRun,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    for (const item of result.clients) {
      console.log(`${item.dry_run ? 'Would sync' : 'Synced'} ${item.client} -> ${item.path}`);
    }
    return;
  }

  if (command === 'expert') {
    const subcommand = positionals[1];

    if (subcommand === 'search') {
      const query = positionals.slice(2).join(' ').trim();
      if (!query) {
        console.error('expert search requires a <query>');
        process.exitCode = 1;
        return;
      }
      const result = searchExperts({ query, limit: options.limit });
      if (result.error) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      printJsonOrText(result, options.json, (payload) =>
        payload.results
          .map((expert) => [expert.name, expert.domain, expert.summary].filter(Boolean).join(' — '))
          .join('\n') || '(no matching expert)');
      return;
    }

    if (subcommand === 'recommend') {
      const task = positionals.slice(2).join(' ').trim();
      if (!task) {
        console.error('expert recommend requires a <task>');
        process.exitCode = 1;
        return;
      }
      const client = options.client === 'all' ? '' : options.client;
      const result = recommendExpert({ task, client, maxRecommendations: options.limit });
      if (result.error) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      printJsonOrText(result, options.json, (payload) =>
        payload.recommendations
          .map((item) => [item.name, item.reason].filter(Boolean).join(' — '))
          .join('\n') || '(no recommendation)');
      return;
    }

    if (subcommand === 'read') {
      const name = positionals[2];
      if (!name) {
        console.error('expert read requires a <name>');
        process.exitCode = 1;
        return;
      }
      try {
        const result = readExpert({ name });
        printJsonOrText(result, options.json, (payload) => payload.content || '');
      } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
      }
      return;
    }

    throw new Error(`Unknown expert command: ${subcommand}`);
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
