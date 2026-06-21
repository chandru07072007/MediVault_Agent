import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";

// Point PDF.js to its bundled worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).toString();

/**
 * PDF viewer using PDF.js — renders pages to canvas with prev/next navigation.
 */
export default function PdfViewer({ url }) {
  const canvasRef = useRef(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Load the PDF document
  useEffect(() => {
    let cancelled = false;

    async function loadPdf() {
      try {
        setLoading(true);
        const doc = await pdfjsLib.getDocument(url).promise;
        if (cancelled) return;
        setPdfDoc(doc);
        setTotalPages(doc.numPages);
        setCurrentPage(1);
      } catch (err) {
        if (!cancelled) setError("Failed to load PDF: " + err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadPdf();
    return () => { cancelled = true; };
  }, [url]);

  // Render the current page
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;

    let cancelled = false;

    async function renderPage() {
      const page = await pdfDoc.getPage(currentPage);
      if (cancelled) return;

      const scale = 1.5;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");

      canvas.width = viewport.width;
      canvas.height = viewport.height;

      await page.render({ canvasContext: ctx, viewport }).promise;
    }

    renderPage();
    return () => { cancelled = true; };
  }, [pdfDoc, currentPage]);

  if (loading) return <div className="viewer-loading">Loading PDF…</div>;
  if (error) return <div className="viewer-error">{error}</div>;

  return (
    <div className="viewer-container pdf-viewer">
      {/* Page navigation */}
      <div className="pdf-nav">
        <button
          onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
          disabled={currentPage <= 1}
          className="btn btn-secondary btn-sm"
        >
          ← Prev
        </button>
        <span className="pdf-page-info">
          Page {currentPage} of {totalPages}
        </span>
        <button
          onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
          disabled={currentPage >= totalPages}
          className="btn btn-secondary btn-sm"
        >
          Next →
        </button>
      </div>

      {/* Canvas */}
      <div className="pdf-canvas-wrapper">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
