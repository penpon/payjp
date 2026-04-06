export type EnvVarValidationResult =
  | { ok: true }
  | { ok: false; missingVars: string[] };
