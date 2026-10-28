import { createDocumentationTrust } from '../../plugins/sleight/lib/canonical-documentation.mjs';

// Tests declare the synthetic bundle's exact documents before sending any result.
// Incoming text never extends this set. Production uses the installed bundle.
export const fixtureDocumentation = (...texts) => createDocumentationTrust({ load: () => ({ texts: texts.flat() }) });
