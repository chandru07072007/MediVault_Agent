import { useEffect, useRef, useState } from "react";
import * as cornerstone from "cornerstone-core";
import * as cornerstoneWADOImageLoader from "cornerstone-wado-image-loader";
import * as dicomParser from "dicom-parser";

// Configure the WADO image loader (runs once)
let initialized = false;
function initCornerstone() {
  if (initialized) return;
  cornerstoneWADOImageLoader.external.cornerstone = cornerstone;
  cornerstoneWADOImageLoader.external.dicomParser = dicomParser;

  // Configure web worker for decoding (optional — falls back to main thread)
  const config = {
    maxWebWorkers: navigator.hardwareConcurrency || 1,
    startWebWorkersOnDemand: true,
    taskConfiguration: {
      decodeTask: { initializeCodecsOnStartup: false },
    },
  };
  cornerstoneWADOImageLoader.webWorkerManager.initialize(config);
  initialized = true;
}

/**
 * DICOM viewer using Cornerstone.js (legacy API).
 * Loads a single-frame DICOM via local File or pre-signed URL.
 */
export default function DicomViewer({ url, file }) {
  const elementRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    initCornerstone();

    const element = elementRef.current;
    if (!element) return;

    cornerstone.enable(element);

    let imageId;
    if (file) {
      imageId = cornerstoneWADOImageLoader.wadouri.fileManager.add(file);
    } else {
      imageId = `wadouri:${url}`;
    }

    cornerstone
      .loadAndCacheImage(imageId)
      .then((image) => {
        cornerstone.displayImage(element, image);
        setLoading(false);
      })
      .catch((err) => {
        console.error("DICOM load error:", err);
        setError("Failed to load DICOM image. " + (err.message || ""));
        setLoading(false);
      });

    return () => {
      try {
        cornerstone.disable(element);
      } catch {
        /* element may already be cleaned up */
      }
    };
  }, [url, file]);

  return (
    <div className="viewer-container dicom-viewer">
      {loading && <div className="viewer-loading">Loading DICOM image…</div>}
      {error && <div className="viewer-error">{error}</div>}
      <div
        ref={elementRef}
        style={{
          width: "100%",
          height: "512px",
          background: "#000",
          borderRadius: "8px",
          display: error ? "none" : "block",
        }}
      />
    </div>
  );
}
