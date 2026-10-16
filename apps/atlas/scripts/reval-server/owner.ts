// R-EVAL RS-A owner CLI O (docs/stage5/ask/remote/reval-server/rs-a/IMPLEMENTATION_BRIEF.md §2a): run in the owner's own
// terminal as `node scripts/reval-server/owner.ts --config <abs path>`. It spawns ONLY the production controller.
import { PRODUCTION_ENTRIES } from '../../packages/reval/launch.ts';
import { runOwner } from '../../packages/reval/owner-cli.ts';

await runOwner({ argv: process.argv.slice(2), controllerEntry: PRODUCTION_ENTRIES.controller });
