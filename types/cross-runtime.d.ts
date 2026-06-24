declare const Deno: {
  run: unknown;
  env: { get(key: string): string | undefined };
} | undefined;

declare const Bun: {
  spawn: unknown;
} | undefined;
