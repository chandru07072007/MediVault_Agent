import { getFileTypeLabel } from "../../utils/fileTypeUtils";

/**
 * Fallback viewer for unsupported file types.
 * Shows the file name and a download button.
 */
export default function GenericViewer({ url, fileName }) {
  const label = getFileTypeLabel("other");

  return (
    <div className="viewer-container generic-viewer">
      <div className="generic-content">
        <div className="generic-icon">📁</div>
        <h3>{fileName}</h3>
        <p className="generic-label">{label} — Preview not available</p>
        <a
          href={url}
          download={fileName}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-primary"
          style={{ marginTop: "1rem", display: "inline-block", textDecoration: "none" }}
        >
          ⬇ Download File
        </a>
      </div>
    </div>
  );
}
