import { useEffect, useState } from "react";
import * as XLSX from "xlsx";

/**
 * Excel / CSV viewer using SheetJS.
 * Fetches the file as ArrayBuffer, parses it, and renders the first sheet as an HTML table.
 */
export default function ExcelViewer({ url, fileName }) {
  const [tableHtml, setTableHtml] = useState("");
  const [sheetNames, setSheetNames] = useState([]);
  const [activeSheet, setActiveSheet] = useState("");
  const [workbook, setWorkbook] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Fetch and parse the workbook
  useEffect(() => {
    let cancelled = false;

    async function loadExcel() {
      try {
        setLoading(true);
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        if (cancelled) return;

        const wb = XLSX.read(buffer, { type: "array" });
        setWorkbook(wb);
        setSheetNames(wb.SheetNames);
        setActiveSheet(wb.SheetNames[0]);
      } catch (err) {
        if (!cancelled) setError("Failed to load spreadsheet: " + err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadExcel();
    return () => { cancelled = true; };
  }, [url]);

  // Render the active sheet as HTML
  useEffect(() => {
    if (!workbook || !activeSheet) return;
    const ws = workbook.Sheets[activeSheet];
    const html = XLSX.utils.sheet_to_html(ws, { id: "excel-preview-table" });
    setTableHtml(html);
  }, [workbook, activeSheet]);

  if (loading) return <div className="viewer-loading">Loading spreadsheet…</div>;
  if (error) return <div className="viewer-error">{error}</div>;

  return (
    <div className="viewer-container excel-viewer">
      {/* Sheet tabs (if multiple sheets) */}
      {sheetNames.length > 1 && (
        <div className="excel-sheet-tabs">
          {sheetNames.map((name) => (
            <button
              key={name}
              className={`sheet-tab ${name === activeSheet ? "active" : ""}`}
              onClick={() => setActiveSheet(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {/* Table */}
      <div
        className="excel-table-wrapper"
        dangerouslySetInnerHTML={{ __html: tableHtml }}
      />
    </div>
  );
}
