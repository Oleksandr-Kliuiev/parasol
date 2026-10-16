import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { command, safeEnvironment } from './runtime.mjs';
import { REQUIRED_ARTIFACTS } from './plan.mjs';

export async function buildApplications(state, skipBuild = false, signal) {
  if (!skipBuild) {
    const steps = [
      ['Atlas API and console build', 'npm', ['run', 'api:build'], 'apps/atlas'],
      ['CRM SPA build', 'npm', ['run', 'build'], 'apps/crm/web'],
      ['CRM Web build', 'dotnet', ['build', 'src/Hosts/Crm.Web/Crm.Web.csproj', '-c', 'Release', '--no-restore', '-m:1', '-p:UseSharedCompilation=false'], 'apps/crm'],
      ['CRM Worker build', 'dotnet', ['build', 'src/Hosts/Crm.Worker/Crm.Worker.csproj', '-c', 'Release', '--no-restore', '-m:1', '-p:UseSharedCompilation=false'], 'apps/crm'],
    ];
    for (const [index, [label, binary, args, cwd]] of steps.entries()) {
      console.log(`Composition: ${label}.`);
      await command(binary, args, { cwd: join(state.root, cwd), env: safeEnvironment(), label,
        logPath: join(state.directory, 'logs', `build-${index + 1}.log`), timeout: 600_000, signal });
    }
  }
  for (const relative of REQUIRED_ARTIFACTS) {
    try { await access(join(state.root, relative)); }
    catch { throw new Error('A required compiled artifact is missing; run the full composition build.'); }
  }
  // Presence only supports diagnostics. Acceptance always builds this source in this invocation.
  return { builtInThisRun: !skipBuild, diagnostic: skipBuild };
}
