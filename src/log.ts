export function log(stage: string, data: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), stage, ...data }));
}
