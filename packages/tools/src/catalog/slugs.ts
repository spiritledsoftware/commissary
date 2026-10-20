/**
 * The catalog slug of a service on a domain (#207), the default name of a toolkit added from it: the domain's own label,
 * as a toolkit's default name reads a host (`linear.app` → `linear`, ADR 0037), else the whole domain's. The catalog
 * names its services so (`catalog.ts`) and so does a live lookup (`lookup.ts`).
 */
import { defaultToolkitName, toolkitNameOf } from "../toolkits/names.ts";

export const domainSlug = (domain: string): string =>
  URL.canParse(`https://${domain}/`)
    ? defaultToolkitName(new URL(`https://${domain}/`))
    : toolkitNameOf(domain);
