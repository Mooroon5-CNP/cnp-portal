'use strict';
const { createClient, reference, fail } = require('./variables.cjs');
async function environment(env = process.env, client = createClient({ env })) {
  if (!env.CNP_VARIABLES_REF) return env;
  let ref; try { ref = reference(JSON.parse(env.CNP_VARIABLES_REF)); } catch (_) { throw fail('CONFIG_REFERENCE_INVALID'); }
  const timeout = new Promise((_, reject) => { const timer = setTimeout(() => reject(fail('CONFIG_TIMEOUT')), 15000); timer.unref(); });
  const values = await Promise.race([client.readBundle(ref), timeout]);
  // Never pass identity configuration or reference to the application as managed values.
  const result = { ...env, ...values }; delete result.CNP_VARIABLES_REF;
  return result;
}
function resolveCommand(command, env = process.env) {
  const path = require('path'); const fs = require('fs');
  const candidates = command.includes('/') ? [path.resolve(command)] : (env.PATH || '').split(path.delimiter).map(dir => path.join(dir, command));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch (_) { /* Try next PATH entry. */ }
  }
  throw fail('CONFIG_COMMAND_INVALID');
}
function launch(command, env) {
  const executable = resolveCommand(command[0], env);
  if (typeof process.execve === 'function') { process.execve(executable, command, env); return; }
  // Node 20-compatible supervisor for existing Node images such as Pixel App.
  // argv arrays only: never interpolate values into a shell command.
  const child = require('child_process').spawn(executable, command.slice(1), { env, stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.once('error', () => { console.error('CONFIG_COMMAND_FAILED'); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
    else process.exitCode = code;
  });
}
async function main() {
  const command = process.argv.slice(2);
  if (!command.length) throw fail('CONFIG_COMMAND_INVALID');
  const env = await environment();
  launch(command, env);
}
if (require.main === module) main().catch(() => { console.error('CONFIG_STARTUP_FAILED: application not started; check provider connectivity, identity and configuration reference.'); process.exitCode = 1; });
module.exports = { environment, resolveCommand };
