// R-EVAL RS-A controller C (brief §2a): spawned by the owner CLI only (fd 3 = its private socketpair end). Production
// dependencies only: unix-socket physical binding, the pinned peer helper and the production child entries.
import { createController, productionDeps } from '../../packages/reval/controller.ts';

await createController(productionDeps()).run();
