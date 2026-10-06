// `step.waitForEvent` throws when its timeout passes, and a Swarm run uses that timeout as the
// tick of its loop. Local workerd names the error `WorkflowTimeoutError`; the deployed engine
// throws a plain Error whose message reads "Execution timed out after <n>ms" (recorded on the
// test deployment on 2026-10-05). Both are a tick; anything else is a failure of the run.

export function isWaitTimeout(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return cause.name === "WorkflowTimeoutError" || /^Execution timed out after \d+\s*ms$/.test(cause.message);
}
