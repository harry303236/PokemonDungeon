import zh from './zh-Hant.json';
const DICT = zh as Record<string, string>;
export function t(key: string, vars: Record<string, string | number> = {}): string {
  const s = DICT[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}
