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
  ackSupervisorEvent,
  failInstallWithoutDryRun,
  getSupervisorStatus,
  listSupervisorEvents,
  listSupervisorSpecs,
  planSupervisorInstall,
} from './lib/supervisor_tools.mjs';

function printUsage() {
  console.log(`Usage:
  qe-mcp init-registry [--registry path] [--force]
  qe-mcp doctor [--registry path] [--json]
  qe-mcp sync [--registry path] [--client claude|codex|gemini|all] [--dry-run]
  qe-mcp supervisor status [--workspace path] [--global] [--json]
  qe-mcp supervisor events [--workspace path] [--global] [--severity WARN|FAIL|CRITICAL] [--limit n] [--json]
  qe-mcp supervisor ack <event_id> [--workspace path] [--global] [--actor name] [--json]
  qe-mcp supervisor specs [--monitor-id id] [--json]
  qe-mcp supervisor install --dry-run [--json]

Notes:
  - The registry is global by default: ~/.qe/mcp/registry.json
  - sync writes client-specific MCP configuration files
  - supervisor install is dry-run only in this phase
  - the default server is qeExpertLibrary`);
}

function parseArgs(argv) {
  const options = {
    registry: getDefaultRegistryPath(),
    force: false,
    json: false,
    dryRun: false,
    client: 'all',
    workspaceRoot: process.cwd(),
    scope: 'workspace',
    limit: undefined,
    severity: undefined,
    actor: undefined,
    monitorId: undefined,
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
    if (token === '--workspace') {
      options.workspaceRoot = argv[index + 1] || options.workspaceRoot;
      index += 1;
      continue;
    }
    if (token === '--limit') {
      options.limit = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--severity') {
      options.severity = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--actor') {
      options.actor = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--monitor-id') {
      options.monitorId = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--global') {
      options.scope = 'global';
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

function supervisorArgs(options) {
  return {
    workspace_root: options.workspaceRoot,
    scope: options.scope,
    limit: options.limit,
    severity: options.severity,
    actor: options.actor,
    monitor_id: options.monitorId,
  };
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

  if (command === 'supervisor') {
    const subcommand = positionals[1] || 'status';
    const baseArgs = supervisorArgs(options);
    if (subcommand === 'status') {
      const result = getSupervisorStatus(baseArgs);
      printJsonOrText(result, options.json, (payload) => {
        return `Supervisor: ${payload.status}\nUnacked: ${payload.summary.unacked}\nEvents: ${payload.summary.total_events}`;
      });
      return;
    }
    if (subcommand === 'events') {
      const result = listSupervisorEvents(baseArgs);
      printJsonOrText(result, options.json, (payload) => {
        if (payload.status === 'error') return payload.errors?.[0]?.message || 'supervisor events failed';
        return payload.events
          .map((event) => `${event.severity} ${event.event_id}: ${event.summary}`)
          .join('\n') || 'No supervisor events';
      });
      if (result.status === 'error') process.exitCode = 1;
      return;
    }
    if (subcommand === 'ack') {
      const eventId = positionals[2];
      const result = ackSupervisorEvent({ ...baseArgs, event_id: eventId });
      printJsonOrText(result, options.json, (payload) => `${payload.status}: ${payload.event_id || eventId}`);
      if (result.status === 'error') process.exitCode = 1;
      return;
    }
    if (subcommand === 'specs') {
      const result = listSupervisorSpecs(baseArgs);
      printJsonOrText(result, options.json, (payload) => {
        return payload.specs.map((spec) => `${spec.monitor_id}: ${spec.safe_command}`).join('\n');
      });
      return;
    }
    if (subcommand === 'install') {
      const result = options.dryRun ? planSupervisorInstall(baseArgs) : failInstallWithoutDryRun();
      printJsonOrText(result, options.json, (payload) => {
        if (payload.status === 'error') return payload.error.message;
        return `Supervisor install ${payload.status}; side_effects=${payload.side_effects}`;
      });
      if (result.status === 'error') process.exitCode = 1;
      return;
    }
    throw new Error(`Unknown supervisor command: ${subcommand}`);
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
