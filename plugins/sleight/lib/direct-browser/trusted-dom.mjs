import { sealDigest } from './seal-digest.mjs';
// Playwright 1.64.0 is pinned and runs in-process, including when its browser
// transport uses CDP. The client bridge resolves the exact held node; the server
// adopts it into that frame's utility world without consulting page JavaScript.
// There is deliberately no MAIN-world or selector-based fallback.
async function utilityFor(handle) {
  const node = handle?._connection?.toImpl?.(handle);
  if (!node || node._frame?._page?.delegate?.noUtilityWorld?.()) throw Error('TRUSTED_DOM_REQUIRED');
  const utility = await node._frame?.utilityContext?.();
  if (utility?.world !== 'utility' || typeof utility.evaluateExpression !== 'function')
    throw Error('TRUSTED_DOM_REQUIRED');
  return { node, utility };
}

// Select prototypes from this pristine utility realm, including for nodes from
// ancestor frames. Starting at the object's own prototype would trust a named
// properties object or an ancestor frame's MAIN-world prototype. Window's
// unforgeable own accessors are captured here too, before any reader can focus.
function nativeReader() {
  const windowProperties = Object.getOwnPropertyDescriptors(window);
  const prototypes = [HTMLInputElement, HTMLButtonElement, HTMLSelectElement, HTMLTextAreaElement,
    HTMLFormElement, HTMLFieldSetElement, HTMLOutputElement, HTMLOptionElement, HTMLOptGroupElement,
    HTMLLabelElement, HTMLIFrameElement, HTMLImageElement, HTMLElement, Element, Document, ShadowRoot, DocumentFragment, Node];
  const tables = prototypes.map(type => [type, Object.getOwnPropertyDescriptors(type.prototype)]);
  return (node, key) => {
    if (node === null || node === undefined) return undefined;
    let descriptor;
    // instanceof does not cover ancestor-frame nodes. Native brand checks on
    // getters do, so select the prototype by Node's native nodeType/localName.
    const type = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeType').get;
    let nodeType;
    try { nodeType = type.call(node); } catch {}
    if (nodeType) {
      const tag = nodeType === 1 ? Object.getOwnPropertyDescriptor(Element.prototype, 'localName').get.call(node) : '';
      const names = {input: HTMLInputElement, button: HTMLButtonElement, select: HTMLSelectElement, textarea: HTMLTextAreaElement,
        form: HTMLFormElement, fieldset: HTMLFieldSetElement, output: HTMLOutputElement, option: HTMLOptionElement,
        optgroup: HTMLOptGroupElement, label: HTMLLabelElement, iframe: HTMLIFrameElement, img: HTMLImageElement};
      const types = nodeType === 9 ? [Document, Node] : nodeType === 11 ? [ShadowRoot, DocumentFragment, Node] :
        nodeType === 1 ? [names[tag], HTMLElement, Element, Node] : [Node];
      for (const type of types) {
        descriptor = tables.find(([candidate]) => candidate === type)?.[1][key];
        if (descriptor) break;
      }
    } else {
      // Only Window objects use this branch in the trusted readers. A native
      // Window accessor enforces the receiver brand; absent evidence refuses.
      descriptor = windowProperties[key];
    }
    if (!descriptor) return undefined;
    const value = descriptor.get ? descriptor.get.call(node) : descriptor.value;
    return typeof value === 'function' ? value.bind(node) : value;
  };
}

// Readers get the native reader and sealDigest (seal-digest.mjs), so a read can carry the digest of the
// same node it classified, taken in the same synchronous step.
// A reader that calls closure-free helpers lists them in reader.helpers. They follow as hoisted declarations,
// so the reader stays the first function in the source.
function expression(reader) {
  const call = '(' + reader.toString() + ')(el, arg, (' + nativeReader.toString() + ')(), (' + sealDigest.toString() + '))';
  if (!reader.helpers?.length) return '([el, arg]) => ' + call;
  return '([el, arg]) => { return ' + call + '; ' + reader.helpers.map(helper => helper.toString()).join(' ') + ' }';
}

export async function trustedRead(handle, reader, arg) {
  const { node, utility } = await utilityFor(handle);
  return utility.evaluateExpression(expression(reader), { isFunction: true }, [node, arg]);
}

// For a node trustedHandle returned: it is already the server-side handle, in the same frame's utility world.
export async function trustedReadNode(node, reader, arg) {
  const utility = await node?._frame?.utilityContext?.();
  if (utility?.world !== 'utility' || typeof utility.evaluateExpression !== 'function') throw Error('TRUSTED_DOM_REQUIRED');
  return utility.evaluateExpression(expression(reader), { isFunction: true }, [node, arg]);
}

export async function trustedHandle(handle, reader) {
  const { node, utility } = await utilityFor(handle);
  return utility.evaluateExpressionHandle(expression(reader), { isFunction: true }, [node, undefined]);
}

export async function trustedLocatorRead(locator, reader, arg) {
  const handle = typeof locator.elementHandle === 'function' ? await locator.elementHandle({ timeout: 1000 }) : locator;
  try { return await trustedRead(handle, reader, arg); }
  finally { if (handle !== locator) await handle?.dispose(); }
}
