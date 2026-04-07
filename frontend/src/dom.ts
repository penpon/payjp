export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  children?: (Node | string)[],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      element.setAttribute(key, value);
    }
  }
  if (children) {
    for (const child of children) {
      element.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
  }
  return element;
}
