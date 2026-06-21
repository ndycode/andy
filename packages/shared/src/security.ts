/** Constant-time string compare to avoid timing leaks on secret boundary checks. */
export function constantTimeEqual(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLength; i++) {
    diff |= codeUnitAt(a, i) ^ codeUnitAt(b, i);
  }
  return diff === 0;
}

function codeUnitAt(value: string, index: number): number {
  return index < value.length ? value.charCodeAt(index) : 0;
}
