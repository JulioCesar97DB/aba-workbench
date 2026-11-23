import { Trans } from "react-i18next";
import type { ComponentProps } from "react";
import { Term } from "./Term.tsx";

/** A translated sentence whose <term></term> parts are English terms (rendered with <Term>). */
export function TransWithTerms(props: Omit<ComponentProps<typeof Trans>, "components">) {
  return <Trans {...props} components={{ term: <Term /> }} />;
}
