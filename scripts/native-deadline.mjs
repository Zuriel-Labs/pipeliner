// Qualification only: signal the owned ChildProcess handle, never a process group.
export function nativeDeadline(child, milliseconds = 180000, grace = 5000) {
  let force;
  const timer = setTimeout(() => { child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), grace); }, milliseconds);
  const cancel = () => { clearTimeout(timer); clearTimeout(force); };
  child.once('close', cancel);
  return cancel;
}
