import { pathToFileURL } from 'node:url';
import { runDemo } from '../fixtures/run-demo.ts';
export { runDemo };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { context } = await runDemo();
  console.log(JSON.stringify(context, null, 2));
}
