/** A new random id of the Tools part's rows: `prefix`, an underscore and 24 hex digits (`tk_…`, `tg_…`, `bp_…`). */
export const freshId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
