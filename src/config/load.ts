import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse } from 'yaml';
import { configSchema, type AuditConfig } from './schema.js';

export interface LoadedConfig {
  config: AuditConfig;
  path: string;
  raw: string;
  /** Risolve un percorso relativo alla cartella del file di configurazione. */
  resolvePath(p: string): string;
}

export function loadConfig(path: string): LoadedConfig {
  const abs = resolve(path);
  return loadConfigText(readFileSync(abs, 'utf8'), abs);
}

/** Configurazione da un testo YAML (es. quello conservato in una rilevazione), con i percorsi relativi a `path`. */
export function loadConfigText(raw: string, path: string): LoadedConfig {
  const abs = resolve(path);
  const parsed = configSchema.safeParse(parse(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(radice)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configurazione non valida (${abs}):\n${issues}`);
  }
  const base = dirname(abs);
  return {
    config: parsed.data,
    path: abs,
    raw,
    resolvePath: (p: string) => (isAbsolute(p) ? p : resolve(base, p)),
  };
}
