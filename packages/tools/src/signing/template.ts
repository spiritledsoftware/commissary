/**
 * The templates a toolkit's `compound` settings place a credential's named fields with (#206): `{name}` stands for the
 * field `name`, as integrations.sh's header patterns write it (`Authorization: Bearer {token}`), in a header's or a
 * query parameter's value or the base URL.
 */

const PLACEHOLDER = /\{([A-Za-z0-9_.-]+)\}/g;

/** The fields `template` names, each once, in order. */
export const templateFields = (template: string): ReadonlyArray<string> => [
  ...new Set(Array.from(template.matchAll(PLACEHOLDER), (match) => match[1] ?? "")),
];

export type Rendered =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly missing: string };

/** `template` with each field's value (passed through `encode`, a URL's), or the first field `fields` lacks. */
export const renderTemplate = (
  template: string,
  fields: Readonly<Record<string, string>>,
  encode: (value: string) => string = (value) => value,
): Rendered => {
  const missing = templateFields(template).find((name) => !Object.hasOwn(fields, name));

  if (missing !== undefined) return { ok: false, missing };

  return {
    ok: true,
    value: template.replace(PLACEHOLDER, (_, name: string) => encode(fields[name] ?? "")),
  };
};

/** `template` with every field it names standing in as `value` (a base URL checked before any field is known). */
export const templateAs = (template: string, value: string): string =>
  template.replace(PLACEHOLDER, value);
