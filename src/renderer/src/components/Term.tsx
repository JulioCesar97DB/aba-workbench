import type { ReactNode } from "react";

/**
 * A clinical term or section name that stays in English whatever the screen language,
 * marked lang="en" so a screen reader reads it in English.
 */
export function Term({ children }: { children?: ReactNode }) {
  return <span lang="en">{children}</span>;
}
