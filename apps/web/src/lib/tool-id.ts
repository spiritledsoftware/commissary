// A tool's stable id is `<toolkit id>:<upstream name>` (ADR 0037): the parts of it the panel names. Pure: no DOM.

/** The part of a stable id after its toolkit's id: the tool's upstream name. */
export const upstreamNameOf = (id: string): string => id.slice(id.indexOf(":") + 1);

/** The part of a stable id before the upstream name: its toolkit's id. */
export const toolkitIdOf = (id: string): string => id.slice(0, Math.max(0, id.indexOf(":")));
