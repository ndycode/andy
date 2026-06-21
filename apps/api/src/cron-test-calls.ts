export type CronCall = {
  readonly fn: string;
  readonly args: readonly unknown[];
};

export function countCronCalls(calls: readonly CronCall[], fn: string): number {
  return calls.filter((call) => call.fn === fn).length;
}

export function cronArgsFor(calls: readonly CronCall[], fn: string): readonly unknown[] {
  const call = calls.find((item) => item.fn === fn);
  if (!call) throw new Error(`missing call: ${fn}`);
  return call.args;
}

export function recordCronCall(calls: CronCall[], fn: string, ...args: unknown[]): void {
  calls.push({ fn, args });
}
