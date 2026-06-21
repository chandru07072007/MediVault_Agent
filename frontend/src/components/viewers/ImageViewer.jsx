import { useState } from "react";

/**
 * Simple image viewer — renders the pre-signed S3 URL in an <img> tag.
 */
export default function ImageViewer({ url, fileName }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  return (
    <div className="viewer-container image-viewer">
      {!loaded && !error && <div className="viewer-loading">Loading image…</div>}
      {error && <div className="viewer-error">Failed to load image.</div>}
      <img
        src={url}
        alt={fileName}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
        style={{
          maxWidth: "100%",
          maxHeight: "70vh",
          objectFit: "contain",
          display: loaded ? "block" : "none",
          margin: "0 auto",
          borderRadius: "8px",
        }}
      />
    </div>
  );
}
