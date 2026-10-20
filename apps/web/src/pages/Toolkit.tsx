// One toolkit (/tools/$toolkitId, #208): what it is and where it comes from, what needs attention, its sign-ins (the
// shared credential for org admins, the caller's own where the toolkit and the org take one), its tool list, and, for
// its managers, its settings. The server decides what the caller sees; the page offers only what it would accept
// (`controlsFor`).
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import type { ToolkitView } from "@commissary/contract/tools";
import { meAtom, toolkitsAtom } from "../api/client.ts";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import { formatCost, formatCount, formatDate } from "../lib/format.ts";
import {
  acceptsLabel,
  controlsFor,
  flagsOf,
  kindLabel,
  noPrivateCredentialText,
  sourceText,
  type ToolkitControls,
  type ToolsCaller,
  toolsCallerOf,
} from "../lib/toolkits.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { CredentialSlotBlock } from "./ToolkitCredential.tsx";
import { Flags } from "./ToolkitFlags.tsx";
import { ToolkitSettings } from "./ToolkitSettings.tsx";
import { ToolList } from "./ToolkitTools.tsx";
import styles from "./Tools.module.css";

const route = getRouteApi("/tools/$toolkitId");

/**
 * Loads the toolkits and the caller, then renders `children` with the toolkit `id` names (the list holds every toolkit
 * the caller may see; there is no read of one).
 */
export const WithToolkit = ({
  id,
  children,
}: {
  readonly id: string;
  readonly children: (toolkit: ToolkitView, caller: ToolsCaller) => ReactNode;
}) => {
  const result = useAtomValue(toolkitsAtom);
  const retry = useAtomRefresh(toolkitsAtom);
  const me = useAtomValue(meAtom);

  if (!AsyncResult.isSuccess(me)) return null;
  const caller = toolsCallerOf(me.value);

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading the toolkit…
      </p>
    ),
    onFailure: (failure) => (
      <Problem onRetry={retry}>Could not load the toolkit. {failureMessage(failure)}</Problem>
    ),
    onSuccess: ({ value }) => {
      const toolkit = value.toolkits.find((each) => each.id === id);

      return toolkit === undefined ? (
        <Problem>
          That toolkit is gone, or is not one you can use. An org admin grants an org
          toolkit&rsquo;s tools on the Grants page.
        </Problem>
      ) : (
        children(toolkit, caller)
      );
    },
  });
};

const Facts = ({ toolkit }: { readonly toolkit: ToolkitView }) => {
  const list = toolkit.tool_list;

  return (
    <dl className={styles["facts"]}>
      <dt>Kind</dt>
      <dd>{kindLabel(toolkit.kind)}</dd>
      <dt>Source</dt>
      <dd>{sourceText(toolkit)}</dd>
      {toolkit.base_url === undefined ? null : (
        <>
          <dt>Base URL</dt>
          <dd>{toolkit.base_url}</dd>
        </>
      )}
      <dt>Whose</dt>
      <dd>{toolkit.private ? "Yours, private" : "The org's"}</dd>
      {toolkit.private || toolkit.built_in === true ? null : (
        <>
          <dt>Accepts</dt>
          <dd>{acceptsLabel(toolkit.accepts)}</dd>
        </>
      )}
      {toolkit.credentials.private_count === undefined ? null : (
        <>
          <dt>Private credentials</dt>
          <dd>
            {toolkit.credentials.private_count === 1
              ? "1 member connected one"
              : `${formatCount(toolkit.credentials.private_count)} members connected one`}
          </dd>
        </>
      )}
      <dt>Per call</dt>
      <dd>
        {toolkit.price_micros === undefined ? "Unpriced" : formatCost(toolkit.price_micros)}
        {toolkit.private ? "" : ", unless a tool is priced on its own"}
      </dd>
      <dt>Listed</dt>
      <dd>{list.built_at === undefined ? "Not yet" : formatDate(Date.parse(list.built_at))}</dd>
      {toolkit.catalog === undefined ? null : (
        <>
          <dt>From the catalog</dt>
          <dd>{toolkit.catalog.service}</dd>
        </>
      )}
    </dl>
  );
};

const SignIns = ({
  toolkit,
  caller,
  controls,
}: {
  readonly toolkit: ToolkitView;
  readonly caller: ToolsCaller;
  readonly controls: ToolkitControls;
}) => (
  <Section title="Sign-in" className={styles["section"]}>
    {!controls.shared && !controls.private ? (
      <p className={styles["empty"]}>{noPrivateCredentialText(toolkit, caller)}</p>
    ) : (
      <div className={styles["slots"]}>
        {controls.shared ? (
          <CredentialSlotBlock toolkit={toolkit} slot="shared" manage={controls.manage} />
        ) : null}
        {controls.private ? (
          <CredentialSlotBlock toolkit={toolkit} slot="private" manage={controls.manage} />
        ) : null}
      </div>
    )}
  </Section>
);

const Details = ({
  toolkit,
  caller,
}: {
  readonly toolkit: ToolkitView;
  readonly caller: ToolsCaller;
}) => {
  const controls = controlsFor(toolkit, caller);
  const flags = flagsOf(toolkit);

  return (
    <>
      <Facts toolkit={toolkit} />
      <Flags flags={flags} label="Needs attention" />
      <SignIns toolkit={toolkit} caller={caller} controls={controls} />
      <ToolList toolkit={toolkit} manage={controls.manage} refresh={controls.refresh} />
      {controls.manage && toolkit.built_in !== true ? <ToolkitSettings toolkit={toolkit} /> : null}
    </>
  );
};

export const ToolkitPage = () => {
  const { toolkitId } = route.useParams();
  const list = useAtomValue(toolkitsAtom);

  const name = AsyncResult.isSuccess(list)
    ? list.value.toolkits.find((each) => each.id === toolkitId)?.name
    : undefined;

  usePageTitle(name ?? "Toolkit");

  return (
    <div className={kit["page"]}>
      <header className={styles["head"]}>
        <Link to="/tools" className={styles["back"]}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
          Tools
        </Link>
        <h1 className={styles["title"]}>{name ?? "Toolkit"}</h1>
      </header>
      <WithToolkit id={toolkitId}>
        {(toolkit, caller) => <Details toolkit={toolkit} caller={caller} />}
      </WithToolkit>
    </div>
  );
};
