// Side-effect import for the eval tests: installs the fail-closed network guard. Import it FIRST in a test file.
import { installNetworkGuard } from './net-guard.ts';

installNetworkGuard();
