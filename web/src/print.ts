/**
 * Print a PDF without leaving the page: load it in a hidden frame and open
 * the browser's print dialog (on a receipt printer, pick it once and the
 * browser remembers). Falls back to opening the PDF in a new tab.
 */
export function printPdf(url: string): void {
  document.querySelectorAll('iframe.print-frame').forEach((f) => f.remove());
  const frame = document.createElement('iframe');
  frame.className = 'print-frame';
  frame.title = 'Print';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
  let fellBack = false;
  const fallback = () => {
    if (fellBack) return;
    fellBack = true;
    window.open(url, '_blank', 'noopener');
  };
  frame.onload = () => {
    try {
      // The PDF viewer needs a moment after load before it can print.
      setTimeout(() => {
        try {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
        } catch {
          fallback();
        }
      }, 300);
    } catch {
      fallback();
    }
  };
  frame.src = url;
  document.body.appendChild(frame);
}
