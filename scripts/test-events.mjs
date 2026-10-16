// Node's CLI drives the runner; this reporter keeps machine-readable results only.
export default async function* events(source) {
  for await (const { type, data } of source) {
    if (['test:fail', 'test:summary', 'test:stdout', 'test:stderr'].includes(type)) {
      const error = data.details?.error;
      yield JSON.stringify({ type, ...data, error: error && {
        message: error.message, cause: error.cause?.message,
        failureType: error.failureType,
      } }) + '\n';
    }
  }
}
