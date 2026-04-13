/** Express may type `req.params` values as `string | string[]` in some setups. */
export function singleParam(value: string | string[] | undefined): string {
  if (value === undefined) return "";
  return Array.isArray(value) ? String(value[0] ?? "") : String(value);
}
