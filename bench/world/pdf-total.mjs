import { randomInt } from 'node:crypto';
import { textPdf } from '../pdf-fixture.mjs';

// Standalone held-out task data. The world catalog can adopt it after live qualification.
export function pdfTotalFixture({ cents = randomInt(10000, 999999) } = {}) {
  if (!Number.isInteger(cents) || cents < 10000 || cents > 999998) throw Error('Invalid PDF total fixture.');
  const total = (cents / 100).toFixed(2);
  const pdf = textPdf(['Invoice summary. Estimated total: 19.50. See page 3 for the final total.',
    'Payment terms. Example amount: 87.10. See page 3 for the final total.', `Final invoice total: USD ${total}.`]);
  return Object.freeze({ id: 'pdf-total', total, pdf,
    prompt: origin => `Open ${origin}/pdf-total, follow the invoice link, and read the final invoice total on page 3. Reply exactly "Page 3: USD <total>" with the amount from the document.`,
    serve(request, response) {
      if (request.url === '/pdf-total') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<!doctype html><title>Invoice fixture</title><a href="/invoice">Read invoice PDF</a>');
      } else if (request.url === '/invoice') {
        response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length }); response.end(pdf);
      } else { response.writeHead(404); response.end(); }
    },
    grade(answer) {
      const match = /^Page 3:\s*USD (\d+\.\d{2})\.?$/i.exec(String(answer).trim());
      return match?.[1] === total || 'PDF_TOTAL_OR_PAGE_MISSING';
    },
  });
}
