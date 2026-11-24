/**
 * Gives an element whose text is cut by an ellipsis (`truncate`) its whole text as a tooltip,
 * and takes it away when the text fits: called as the pointer enters it (and as it takes the
 * focus, for the screen's title). A screen reader reads the whole text from the element itself.
 */
export function titleWhenCut(element: HTMLElement, text: string): void {
  if (element.scrollWidth > element.clientWidth) element.title = text;
  else element.removeAttribute("title");
}
