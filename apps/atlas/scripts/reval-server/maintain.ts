// R-EVAL RS-B owner maintenance (rs-b brief §1.3): OFFLINE owner tool for the registered synthetic sandbox — `probe`,
// `register`, `install <FXnn> <expectedGeneration>` with `--config <abs path>`. Unix-socket physical binding only; never the
// 06 IPC; the API server must be stopped (another client backend refuses). Prints one JSON line.
import { runMaintain } from '../../packages/reval/maintain-cli.ts';
import { productionMaintainDeps } from '../../packages/reval/maintain-deps.ts';

process.exitCode = await runMaintain(process.argv.slice(2), productionMaintainDeps());
