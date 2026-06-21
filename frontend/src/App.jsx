import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useChunkedUpload } from "./hooks/useChunkedUpload";
import FileUploader from "./components/FileUploader";
import ProgressTracker from "./components/ProgressTracker";
import UploadStatus from "./components/UploadStatus";
import FilePreviewModal from "./components/FilePreviewModal";
import ToastStack from "./components/ToastStack";
import Login from "./components/Login";
import {
  getAccessToken,
  getAccessTokenExpiryEpochMs,
  getCurrentUser,
  logoutUser,
  refreshAccessToken,
  setAuthFailureHandler,
} from "./api/authApi";
import { addBucket, deleteBucket, getBucketUsage, getBuckets, getUploadHistory } from "./api/uploadApi";
import { runAgent } from "./api/agentApi";
import JSZip from "jszip";
import "./App.css";

const TOAST_TTL_MS = 7000;
const COMPLETION_REFRESH_MS = 5000;
const BUCKET_NAME_REGEX = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_FORMAT_REGEX = /^[a-z]{2}-[a-z]+-\d+$/;
const S3_CORS_POLICY_TEMPLATE = `[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "AllowedOrigins": ["http://localhost:5173"],
    "ExposeHeaders": ["ETag", "x-amz-version-id"],
    "MaxAgeSeconds": 3000
  }
]`;

function validateBucketPayload(payload) {
  const errors = {};

  const bucketName = payload.bucket_name || "";
  if (!bucketName) {
    errors.bucket_name = "Bucket name is required.";
  } else if (bucketName.length < 3 || bucketName.length > 63) {
    errors.bucket_name = "Bucket name must be 3-63 characters.";
  } else if (!BUCKET_NAME_REGEX.test(bucketName) || bucketName.includes("..") || bucketName.includes(".-") || bucketName.includes("-.")) {
    errors.bucket_name = "Use lowercase letters, numbers, dots, or hyphens. No underscores.";
  }

  const region = payload.region || "";
  if (!region) {
    errors.region = "Region is required.";
  } else if (!REGION_FORMAT_REGEX.test(region)) {
    errors.region = "Region must look like ap-south-1.";
  }

  const accessKey = payload.aws_access_key_id || "";
  if (!accessKey) {
    errors.aws_access_key_id = "AWS access key is required.";
  } else if (!/^[A-Z0-9]{16,128}$/.test(accessKey)) {
    errors.aws_access_key_id = "Use uppercase letters and numbers only (16-128 chars).";
  }

  const secretKey = payload.aws_secret_access_key || "";
  if (!secretKey) {
    errors.aws_secret_access_key = "AWS secret key is required.";
  } else if (secretKey.length < 16 || secretKey.length > 256) {
    errors.aws_secret_access_key = "Secret key must be between 16 and 256 characters.";
  }

  const sizeLimitGbRaw = `${payload.size_limit_gb ?? ""}`.trim();
  if (!sizeLimitGbRaw) {
    errors.size_limit_gb = "Size limit is required.";
  } else {
    const sizeLimitGb = Number(sizeLimitGbRaw);
    if (!Number.isFinite(sizeLimitGb) || sizeLimitGb <= 0) {
      errors.size_limit_gb = "Size limit must be greater than 0.";
    }
  }

  return errors;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function getDetailMessage(error, fallback) {
  return error?.response?.data?.detail || error?.message || fallback;
}

function App() {
  const [token, setToken] = useState(getAccessToken());
  const [authReady, setAuthReady] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [file, setFile] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [isPreparingFolder, setIsPreparingFolder] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [history, setHistory] = useState([]);
  const [buckets, setBuckets] = useState([]);
  const [bucketUsageByName, setBucketUsageByName] = useState({});
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState(null);
  const [bucketSaving, setBucketSaving] = useState(false);
  const [bucketDeletingId, setBucketDeletingId] = useState(null);
  const [selectedUploadBucket, setSelectedUploadBucket] = useState("");
  const [uploadGrowthFilter, setUploadGrowthFilter] = useState("all");
  const [graphFromDate, setGraphFromDate] = useState("");
  const [graphToDate, setGraphToDate] = useState("");
  const [historySearchQuery, setHistorySearchQuery] = useState("");
  const [historySortFilter, setHistorySortFilter] = useState("latest");
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [showUserDetails, setShowUserDetails] = useState(false);

  // MediPack AI Agent State Variables
  const [agentSearchQuery, setAgentSearchQuery] = useState("");
  const [agentSearchResults, setAgentSearchResults] = useState(null);
  const [agentSearching, setAgentSearching] = useState(false);
  const [analyticsStats, setAnalyticsStats] = useState(null);
  const [summarizingId, setSummarizingId] = useState(null);
  const [activeSummary, setActiveSummary] = useState(null);
  const [predictiveTelemetry, setPredictiveTelemetry] = useState(null);

  const [bucketForm, setBucketForm] = useState({
    bucket_name: "",
    region: "",
    aws_access_key_id: "",
    aws_secret_access_key: "",
    size_limit_gb: "10",
  });
  const [bucketFormErrors, setBucketFormErrors] = useState({});
  const [bucketFormTouched, setBucketFormTouched] = useState({});
  const completionRefreshTimerRef = useRef(null);
  const completionNoticeShownRef = useRef(false);
  const userMenuRef = useRef(null);

  const {
    status,
    progress,
    chunkStatuses,
    error,
    errorMeta,
    networkType,
    displayChunkMB,
    avgUploadSpeedMB,
    prepareUpload,
    upload,
    pause,
    resume,
    cancel,
  } =
    useChunkedUpload();

  const pushToast = useCallback((type, title, message, ttlMs = TOAST_TTL_MS) => {
    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setToasts((prev) => [...prev, { id, type, title, message }]);

    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, ttlMs);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const handleCopyCorsPolicy = useCallback(async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(S3_CORS_POLICY_TEMPLATE);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = S3_CORS_POLICY_TEMPLATE;
        textArea.setAttribute("readonly", "");
        textArea.style.position = "absolute";
        textArea.style.left = "-9999px";
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }

      pushToast("success", "CORS Policy Copied", "Paste it in AWS S3 bucket Permissions > CORS.");
    } catch {
      pushToast("error", "Copy Failed", "Could not copy policy. Copy manually from the block.");
    }
  }, [pushToast]);

  const resetClientAuthState = useCallback(() => {
    setToken(null);
    setCurrentUser(null);
    setActiveTab("dashboard");
    setAuthReady(true);
    setFile(null);
    setShowPreview(false);
    setHistory([]);
    setBuckets([]);
    setBucketUsageByName({});
    setGraphFromDate("");
    setGraphToDate("");
    setHistorySearchQuery("");
    setHistorySortFilter("latest");
    setUserMenuOpen(false);
    setShowUserDetails(false);
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await logoutUser();
    } catch {
      // Best effort server-side logout; local state is still cleared.
    }
    resetClientAuthState();
  }, [resetClientAuthState]);

  const handleToggleUserMenu = useCallback(() => {
    setUserMenuOpen((prev) => !prev);
  }, []);

  const handleShowUserDetails = useCallback(() => {
    setShowUserDetails((prev) => !prev);
  }, []);

  const fetchWorkspaceData = useCallback(async () => {
    if (!token) return;

    setDataLoading(true);
    setDataError(null);

    const [historyResult, bucketsResult, analyticsResult] = await Promise.allSettled([
      getUploadHistory(),
      getBuckets(),
      runAgent("analytics"),
    ]);

    let failedCalls = 0;

    if (historyResult.status === "fulfilled") {
      setHistory(Array.isArray(historyResult.value) ? historyResult.value : []);
    } else {
      failedCalls += 1;
      setHistory([]);
    }

    if (bucketsResult.status === "fulfilled") {
      setBuckets(Array.isArray(bucketsResult.value) ? bucketsResult.value : []);
    } else {
      failedCalls += 1;
      setBuckets([]);
    }

    if (analyticsResult.status === "fulfilled" && analyticsResult.value) {
      setAnalyticsStats(analyticsResult.value);
    } else {
      setAnalyticsStats(null);
    }

    if (failedCalls > 0) {
      setDataError("Some dashboard data could not be loaded.");
      pushToast("warning", "Data Sync Warning", "Some dashboard values could not be loaded from the server.");
    }

    setDataLoading(false);
  }, [token, pushToast]);

  const handleAgentSearch = useCallback(async () => {
    if (!agentSearchQuery.trim()) return;
    setAgentSearching(true);
    setAgentSearchResults(null);
    try {
      const result = await runAgent("search", agentSearchQuery);
      if (result && result.results) {
        setAgentSearchResults(result.results);
        pushToast("success", "Search Agent Complete", `Found ${result.results.length} matched records.`);
      }
    } catch (err) {
      pushToast("error", "Search Agent Failed", err?.response?.data?.detail || "Could not parse query.");
    } finally {
      setAgentSearching(false);
    }
  }, [agentSearchQuery, pushToast]);

  const handleSummarizeReport = useCallback(async (packageId) => {
    setSummarizingId(packageId);
    try {
      const result = await runAgent("summary", { package_id: packageId });
      if (result && result.status === "success") {
        setActiveSummary(result);
        pushToast("success", "Report Summarized", "AI summary and insights generated successfully.");
        await fetchWorkspaceData();
      }
    } catch (err) {
      pushToast("error", "Summarization Failed", err?.response?.data?.detail || "Could not analyze report.");
    } finally {
      setSummarizingId(null);
    }
  }, [fetchWorkspaceData, pushToast]);

  useEffect(() => {
    if (status !== "uploading" || !Number.isFinite(avgUploadSpeedMB)) return;
    
    const fetchPrediction = async () => {
      try {
        const speed = avgUploadSpeedMB;
        const total = chunkStatuses?.length || 1;
        const failed = chunkStatuses?.filter(c => c.status === "failed")?.length || 0;
        
        const result = await runAgent("upload", {
          file_name: file?.name || "upload",
          size: file?.size || 0,
          status: "in_progress",
          network_speed_mb: speed,
          total_parts: total,
          failed_parts: failed,
          user_id: currentUser?.username || "anonymous"
        });
        
        if (result && result.prediction) {
          setPredictiveTelemetry(result.prediction);
        }
      } catch (err) {
        console.error("Failed to fetch predictive telemetry:", err);
      }
    };
    
    fetchPrediction();
    const intervalId = setInterval(fetchPrediction, 15000);
    return () => clearInterval(intervalId);
  }, [status, avgUploadSpeedMB, chunkStatuses, file, currentUser]);

  const handleFileSelect = useCallback(async (selectedFile) => {
    await cancel();
    setFile(selectedFile);
    setShowPreview(false);

    if (!selectedFile) return;

    try {
      await prepareUpload(selectedFile);
    } catch (err) {
      if (err?.code === "FILE_TYPE_NOT_ALLOWED") {
        setFile(null);
        pushToast(
          "error",
          "Unsupported File Type",
          err?.message || "Only DICOM, JPEG, PNG, PDF, and ZIP files are allowed."
        );
        return;
      }

      pushToast(
        "error",
        "Resume Check Failed",
        "Could not verify previous upload session. Please try selecting the file again."
      );
    }
  }, [cancel, prepareUpload, pushToast]);

  const handleFolderSelect = useCallback(async (selectedFiles) => {
    if (!selectedFiles || selectedFiles.length === 0) return;

    await cancel();
    setShowPreview(false);
    setIsPreparingFolder(true);

    try {
      const zip = new JSZip();
      let rootFolderName = "folder";

      selectedFiles.forEach((entry) => {
        const path = entry.webkitRelativePath || entry.name;
        if (!path) return;

        const pathSegments = path.split("/");
        if (pathSegments.length > 1 && pathSegments[0]) {
          rootFolderName = pathSegments[0];
        }

        zip.file(path, entry);
      });

      pushToast("info", "Preparing Folder", "Compressing selected folder before secure upload...");

      const zipBlob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });

      const zipFile = new File([zipBlob], `${rootFolderName}.zip`, {
        type: "application/zip",
        lastModified: Date.now(),
      });

      setFile(zipFile);
      await prepareUpload(zipFile);

      pushToast(
        "success",
        "Folder Ready",
        `Folder compressed to ${zipFile.name} and ready to upload.`
      );
    } catch (err) {
      setFile(null);
      pushToast(
        "error",
        "Folder Upload Failed",
        err?.message || "Could not prepare folder for upload."
      );
    } finally {
      setIsPreparingFolder(false);
    }
  }, [cancel, prepareUpload, pushToast]);

  const handleUpload = useCallback(() => {
    if (file) {
      const normalizedBucket = selectedUploadBucket.trim();
      upload(file, normalizedBucket || null);
    }
  }, [file, selectedUploadBucket, upload]);

  const handleCancel = useCallback(() => {
    cancel();
    setFile(null);
    setShowPreview(false);
  }, [cancel]);

  useEffect(() => {
    if (!errorMeta) return;

    if (errorMeta.kind === "chunk_retry_exhausted") {
      pushToast(
        "error",
        "Chunk Upload Failed",
        "A chunk failed after the maximum retries. Check your network and click Resume to continue."
      );
      return;
    }

    if (errorMeta.kind === "auth") {
      pushToast(
        "warning",
        "Session Requires Login",
        "Upload is paused. Sign in again, then click Resume to continue without losing progress."
      );
      return;
    }

    if (errorMeta.kind === "file_type") {
      pushToast(
        "error",
        "Unsupported File Type",
        errorMeta.message || "Only DICOM, JPEG, PNG, PDF, and ZIP files are allowed."
      );
      return;
    }

    pushToast("error", "Upload Error", errorMeta.message || "Upload failed unexpectedly.");
  }, [errorMeta, pushToast]);

  useEffect(() => {
    const onAuthFailure = () => {
      pushToast(
        "warning",
        "Session Expired",
        "Please sign in again to continue."
      );
      resetClientAuthState();
    };

    setAuthFailureHandler(onAuthFailure);
    return () => {
      setAuthFailureHandler(null);
    };
  }, [pushToast, resetClientAuthState]);

  useEffect(() => {
    if (!token) return;

    const expiryMs = getAccessTokenExpiryEpochMs();
    if (!expiryMs) return;

    const refreshLeadMs = 60 * 1000;
    const refreshInMs = Math.max(expiryMs - Date.now() - refreshLeadMs, 1000);
    let cancelled = false;

    const timerId = window.setTimeout(async () => {
      try {
        const refreshed = await refreshAccessToken();
        if (cancelled) return;
        setToken(refreshed?.access_token || getAccessToken());
      } catch {
        if (cancelled) return;
        pushToast(
          "warning",
          "Session Expired",
          "Please sign in again to continue."
        );
        resetClientAuthState();
      }
    }, refreshInMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [token, pushToast, resetClientAuthState]);

  useEffect(() => {
    let isActive = true;

    const validateToken = async () => {
      if (!token) {
        if (isActive) setAuthReady(true);
        return;
      }

      try {
        const user = await getCurrentUser();
        if (isActive) {
          setCurrentUser(user || null);
          setActiveTab("dashboard");
        }
      } catch (err) {
        if (!isActive) return;
        const status = err?.response?.status;
        if (status === 401 || status === 403) {
          try {
            const refreshed = await refreshAccessToken();
            if (!isActive) return;
            setToken(refreshed?.access_token || getAccessToken());

            const user = await getCurrentUser();
            if (!isActive) return;
            setCurrentUser(user || null);
            setActiveTab("dashboard");
          } catch {
            if (!isActive) return;
            pushToast(
              "warning",
              "Session Expired",
              "Please sign in again to continue uploading."
            );
            resetClientAuthState();
          }
        }
      } finally {
        if (isActive) setAuthReady(true);
      }
    };

    setAuthReady(false);
    validateToken();

    return () => {
      isActive = false;
    };
  }, [token, pushToast, resetClientAuthState]);

  useEffect(() => {
    if (!token || !authReady) return;
    fetchWorkspaceData();
  }, [token, authReady, fetchWorkspaceData]);

  useEffect(() => {
    if (!token || !authReady) return;
    if (status === "completed") {
      fetchWorkspaceData();
    }
  }, [status, token, authReady, fetchWorkspaceData]);

  useEffect(() => {
    let isActive = true;

    const fetchBucketUsageData = async () => {
      if (!token || buckets.length === 0) {
        if (isActive) setBucketUsageByName({});
        return;
      }

      const usageResults = await Promise.allSettled(
        buckets.map(async (bucket) => {
          const usage = await getBucketUsage(bucket.bucket_name);
          return { bucketName: bucket.bucket_name, usage };
        })
      );

      if (!isActive) return;

      const usageMap = {};
      usageResults.forEach((result) => {
        if (result.status !== "fulfilled") return;
        const bucketName = result.value?.bucketName;
        if (!bucketName) return;
        usageMap[bucketName] = result.value.usage;
      });

      setBucketUsageByName(usageMap);
    };

    fetchBucketUsageData();

    return () => {
      isActive = false;
    };
  }, [token, buckets]);

  useEffect(() => {
    if (status !== "completed") {
      completionNoticeShownRef.current = false;
      if (completionRefreshTimerRef.current) {
        window.clearTimeout(completionRefreshTimerRef.current);
        completionRefreshTimerRef.current = null;
      }
      return;
    }

    if (completionNoticeShownRef.current) {
      return;
    }

    completionNoticeShownRef.current = true;
    pushToast(
      "info",
      "Completing Upload",
      "Task is being completed. Upload page will refresh in 5 seconds.",
      COMPLETION_REFRESH_MS,
    );

    completionRefreshTimerRef.current = window.setTimeout(() => {
      setActiveTab("upload");
      handleCancel();
      fetchWorkspaceData();
      completionRefreshTimerRef.current = null;
      completionNoticeShownRef.current = false;
    }, COMPLETION_REFRESH_MS);

    return () => {
      if (completionRefreshTimerRef.current) {
        window.clearTimeout(completionRefreshTimerRef.current);
        completionRefreshTimerRef.current = null;
      }
    };
  }, [status, handleCancel, fetchWorkspaceData, pushToast]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!userMenuRef.current) return;
      if (userMenuRef.current.contains(event.target)) return;
      setUserMenuOpen(false);
      setShowUserDetails(false);
    };

    const handleEsc = (event) => {
      if (event.key !== "Escape") return;
      setUserMenuOpen(false);
      setShowUserDetails(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, []);

  const metrics = useMemo(() => {
    const totalUploadedBytes = history.reduce((acc, record) => acc + Number(record?.size || 0), 0);
    const uniqueUploadBuckets = new Set(history.map((record) => record?.bucket).filter(Boolean)).size;
    const latestUpload = history[0] || null;
    const uploadingNow = status === "uploading" || status === "paused";

    return {
      totalUploadedBytes,
      totalUploads: history.length,
      uniqueUploadBuckets,
      configuredBuckets: buckets.length,
      latestUpload,
      uploadingNow,
    };
  }, [history, buckets.length, status]);

  const dashboardInsights = useMemo(() => {
    const dailyUploadCounts = new Map();
    const uploadPoints = [];

    const bucketStatsMap = new Map();

    history.forEach((record, index) => {
      const createdAt = new Date(record?.created_at || "");
      if (!Number.isNaN(createdAt.getTime())) {
        const dateKey = createdAt.toISOString().slice(0, 10);
        const size = Math.max(0, Number(record?.size || 0));
        dailyUploadCounts.set(dateKey, (dailyUploadCounts.get(dateKey) || 0) + 1);
        uploadPoints.push({
          key: `${record?.id || record?.file_id || "upload"}-${index}`,
          dateKey,
          size,
          createdAtMs: createdAt.getTime(),
          fileName: record?.filename || record?.file_name || "upload",
        });
      }

      const bucketName = record?.bucket || "medivault-bucket";
      const existingBucket = bucketStatsMap.get(bucketName) || { bucket: bucketName, count: 0, bytes: 0 };
      existingBucket.count += 1;
      existingBucket.bytes += Number(record?.size || 0);
      bucketStatsMap.set(bucketName, existingBucket);
    });

    uploadPoints.sort((a, b) => a.createdAtMs - b.createdAtMs || a.size - b.size);

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    let minDate = null;
    if (uploadGrowthFilter === "7") {
      minDate = new Date(todayStart);
      minDate.setDate(todayStart.getDate() - 6);
    } else if (uploadGrowthFilter === "30") {
      minDate = new Date(todayStart);
      minDate.setDate(todayStart.getDate() - 29);
    } else if (uploadGrowthFilter === "month") {
      minDate = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
    }

    let maxDate = null;
    if (graphFromDate) {
      minDate = new Date(`${graphFromDate}T00:00:00`);
    }
    if (graphToDate) {
      maxDate = new Date(`${graphToDate}T23:59:59.999`);
    }

    if (minDate && maxDate && minDate.getTime() > maxDate.getTime()) {
      const temp = minDate;
      minDate = maxDate;
      maxDate = temp;
    }

    const filteredPoints = uploadPoints.filter((point) => {
      if (minDate && point.createdAtMs < minDate.getTime()) return false;
      if (maxDate && point.createdAtMs > maxDate.getTime()) return false;
      return true;
    });

    const filteredDateKeys = Array.from(new Set(filteredPoints.map((point) => point.dateKey))).sort((a, b) => a.localeCompare(b));

    const maxUploadSize = Math.max(
      ...filteredPoints.map((point) => point.size),
      0,
    );

    const todayKey = now.toISOString().slice(0, 10);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yesterdayKey = yesterday.toISOString().slice(0, 10);

    const lifetimeUploadCount = uploadPoints.length;
    const todayUploadCount = dailyUploadCounts.get(todayKey) || 0;
    const yesterdayUploadCount = dailyUploadCounts.get(yesterdayKey) || 0;
    const xAxisLabelStep = Math.max(1, Math.ceil(Math.max(filteredDateKeys.length, 1) / 8));

    const bucketDistribution = Array.from(bucketStatsMap.values())
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 6);
    const maxBucketBytes = bucketDistribution.reduce((max, item) => Math.max(max, item.bytes), 0);

    return {
      points: filteredPoints,
      dateKeys: filteredDateKeys,
      maxUploadSize,
      yesterdayUploadCount,
      todayUploadCount,
      lifetimeUploadCount,
      xAxisLabelStep,
      bucketDistribution,
      maxBucketBytes,
    };
  }, [history, uploadGrowthFilter, graphFromDate, graphToDate]);

  const filteredHistoryRecords = useMemo(() => {
    const normalizedSearch = historySearchQuery.trim().toLowerCase();

    const searched = history.filter((record) => {
      if (!normalizedSearch) return true;

      const fileName = (record?.filename || record?.file_name || "").toLowerCase();
      const bucketName = (record?.bucket || "").toLowerCase();
      const createdDate = (record?.created_at || "").toLowerCase();

      return fileName.includes(normalizedSearch)
        || bucketName.includes(normalizedSearch)
        || createdDate.includes(normalizedSearch);
    });

    const sorted = [...searched].sort((a, b) => {
      const aName = (a?.filename || a?.file_name || "").toLowerCase();
      const bName = (b?.filename || b?.file_name || "").toLowerCase();
      const aSize = Number(a?.size || 0);
      const bSize = Number(b?.size || 0);
      const aCreated = new Date(a?.created_at || 0).getTime();
      const bCreated = new Date(b?.created_at || 0).getTime();

      if (historySortFilter === "size_asc") return aSize - bSize;
      if (historySortFilter === "size_desc") return bSize - aSize;
      if (historySortFilter === "name_asc") return aName.localeCompare(bName);
      if (historySortFilter === "name_desc") return bName.localeCompare(aName);
      return bCreated - aCreated;
    });

    return sorted;
  }, [history, historySearchQuery, historySortFilter]);

  const handleBucketFieldChange = useCallback((field, value) => {
    setBucketForm((prev) => {
      const nextForm = { ...prev, [field]: value };
      if (bucketFormTouched[field]) {
        const validationErrors = validateBucketPayload(nextForm);
        setBucketFormErrors((prevErrors) => ({
          ...prevErrors,
          [field]: validationErrors[field],
        }));
      }
      return nextForm;
    });
  }, [bucketFormTouched]);

  const handleBucketFieldBlur = useCallback((field) => {
    setBucketFormTouched((prev) => ({ ...prev, [field]: true }));
    const validationErrors = validateBucketPayload(bucketForm);
    setBucketFormErrors((prevErrors) => ({
      ...prevErrors,
      [field]: validationErrors[field],
    }));
  }, [bucketForm]);

  const handleAddBucket = useCallback(async (event) => {
    event.preventDefault();
    if (bucketSaving) return;

    const payload = {
      bucket_name: bucketForm.bucket_name.trim(),
      region: bucketForm.region.trim(),
      aws_access_key_id: bucketForm.aws_access_key_id.trim(),
      aws_secret_access_key: bucketForm.aws_secret_access_key.trim(),
      size_limit_gb: bucketForm.size_limit_gb,
    };

    if (!payload.bucket_name || !payload.region || !payload.aws_access_key_id || !payload.aws_secret_access_key || !payload.size_limit_gb) {
      const validationErrors = validateBucketPayload(payload);
      setBucketFormErrors(validationErrors);
      setBucketFormTouched({
        bucket_name: true,
        region: true,
        aws_access_key_id: true,
        aws_secret_access_key: true,
        size_limit_gb: true,
      });
      pushToast("warning", "Validation Required", "Please fix bucket form errors before saving.");
      return;
    }

    const validationErrors = validateBucketPayload(payload);
    if (Object.keys(validationErrors).length > 0) {
      setBucketFormErrors(validationErrors);
      setBucketFormTouched({
        bucket_name: true,
        region: true,
        aws_access_key_id: true,
        aws_secret_access_key: true,
        size_limit_gb: true,
      });
      pushToast("warning", "Validation Required", "Please fix bucket form errors before saving.");
      return;
    }

    const sizeLimitBytes = Math.round(Number(payload.size_limit_gb) * 1024 * 1024 * 1024);

    setBucketSaving(true);
    try {
      const result = await addBucket({
        bucket_name: payload.bucket_name,
        region: payload.region,
        aws_access_key_id: payload.aws_access_key_id,
        aws_secret_access_key: payload.aws_secret_access_key,
        size_limit: sizeLimitBytes,
      });
      pushToast("success", "Bucket Saved", result?.message || "Bucket credentials were saved.");
      setBucketForm((prev) => ({
        ...prev,
        bucket_name: "",
        aws_access_key_id: "",
        aws_secret_access_key: "",
        size_limit_gb: "10",
      }));
      setBucketFormErrors({});
      setBucketFormTouched({});
      await fetchWorkspaceData();

      if (!selectedUploadBucket) {
        setSelectedUploadBucket(payload.bucket_name);
      }
    } catch (err) {
      pushToast("error", "Bucket Save Failed", getDetailMessage(err, "Could not save bucket credentials."));
    } finally {
      setBucketSaving(false);
    }
  }, [bucketForm, bucketSaving, fetchWorkspaceData, pushToast, selectedUploadBucket]);

  const handleDeleteBucket = useCallback(async (bucket) => {
    if (!bucket?.id || bucketDeletingId) return;

    const confirmation = window.confirm(
      `Delete bucket '${bucket.bucket_name}' from saved credentials?`
    );
    if (!confirmation) return;

    setBucketDeletingId(bucket.id);
    try {
      const result = await deleteBucket(bucket.id);
      pushToast("success", "Bucket Deleted", result?.message || "Bucket removed successfully.");

      if (selectedUploadBucket === bucket.bucket_name) {
        setSelectedUploadBucket("");
      }

      await fetchWorkspaceData();
    } catch (err) {
      pushToast("error", "Delete Failed", getDetailMessage(err, "Could not delete bucket."));
    } finally {
      setBucketDeletingId(null);
    }
  }, [bucketDeletingId, fetchWorkspaceData, pushToast, selectedUploadBucket]);

  const renderDataError = dataError ? (
    <div className="rounded-lg border border-error/20 bg-error-container px-4 py-3 text-xs font-semibold text-error">
      {dataError}
    </div>
  ) : null;

  const renderHistoryTable = (records, emptyMessage) => (
    <div className="bg-surface-container-lowest rounded-xl overflow-hidden shadow-[0px_12px_32px_rgba(0,21,42,0.04)]">
      <div className="p-6 border-b border-surface-container-high">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-extrabold tracking-tight text-primary headline">Upload History</h2>
          <p className="text-xs font-semibold text-on-surface-variant">{records.length} records</p>
        </div>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          <input
            type="text"
            className="w-full rounded-lg bg-surface-container-highest border border-surface-container-high px-3 py-2 text-sm"
            placeholder="Search by file, bucket, or date"
            value={historySearchQuery}
            onChange={(event) => setHistorySearchQuery(event.target.value)}
          />
          <select
            className="w-full rounded-lg bg-surface-container-highest border border-surface-container-high px-3 py-2 text-sm"
            value={historySortFilter}
            onChange={(event) => setHistorySortFilter(event.target.value)}
          >
            <option value="latest">Latest first</option>
            <option value="size_asc">Size ascending</option>
            <option value="size_desc">Size descending</option>
            <option value="name_asc">Name A-Z</option>
            <option value="name_desc">Name Z-A</option>
          </select>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left font-body">
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-on-surface-variant bg-surface-container-low/50">
              <th className="px-6 py-4">File</th>
              <th className="px-6 py-4">Bucket</th>
              <th className="px-6 py-4">Size</th>
              <th className="px-6 py-4">Checksum</th>
              <th className="px-6 py-4">AI Agent</th>
              <th className="px-6 py-4 text-right">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-container-high/50">
            {records.length === 0 ? (
              <tr>
                <td colSpan="6" className="px-6 py-10 text-sm font-medium text-on-surface-variant text-center">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              records.map((record) => (
                <tr key={record.id || record.file_id} className="hover:bg-surface-container-low/30 transition-colors">
                  <td className="px-6 py-5 text-sm font-semibold text-primary max-w-[280px] truncate" title={record.filename || record.file_name || "-"}>
                    <div className="flex flex-col">
                      <span className="truncate">{record.filename || record.file_name || "-"}</span>
                      {record.category && (
                        <span className="text-[10px] bg-teal-100 text-teal-800 font-extrabold uppercase px-2 py-0.5 rounded w-max mt-1">
                          {record.category}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-5 text-xs font-bold text-on-surface-variant uppercase tracking-wide">
                    {record.bucket || "medivault-bucket"}
                  </td>
                  <td className="px-6 py-5 text-xs font-bold text-on-surface-variant">{formatBytes(Number(record.size || 0))}</td>
                  <td className="px-6 py-5 text-xs text-on-surface-variant font-mono max-w-[180px] truncate" title={record.checksum || "-"}>
                    {record.checksum || "-"}
                  </td>
                  <td className="px-6 py-5">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={summarizingId === (record.id || record.file_id)}
                        onClick={() => handleSummarizeReport(record.id || record.file_id)}
                        className="rounded-lg bg-teal-50 hover:bg-teal-100 text-teal-800 px-2.5 py-1.5 text-xs font-bold transition-all disabled:opacity-50"
                      >
                        {summarizingId === (record.id || record.file_id) ? "Analyzing..." : record.summary ? "View Summary" : "AI Summarize"}
                      </button>
                      {record.summary && (
                        <button
                          type="button"
                          onClick={() => setActiveSummary({ summary: record.summary, insights: record.insights || [], category: record.category })}
                          className="text-xs text-teal-600 font-bold hover:underline"
                        >
                          Details
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-5 text-xs text-on-surface-variant text-right font-medium">{formatDate(record.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderDashboard = () => (
    <main className="flex-1 w-full max-w-[1440px] mx-auto px-6 lg:px-10 py-10 space-y-8">
      {renderDataError}

      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-surface-container-lowest rounded-xl p-6 shadow-sm border border-surface-container-high">
          <p className="text-xs uppercase tracking-widest font-bold text-on-surface-variant">Total Data Transferred</p>
          <p className="mt-2 text-3xl font-extrabold text-primary headline">
            {analyticsStats ? `${analyticsStats.trends?.data_transferred_gb || 0} GB` : formatBytes(metrics.totalUploadedBytes)}
          </p>
        </div>
        <div className="bg-surface-container-lowest rounded-xl p-6 shadow-sm border border-surface-container-high">
          <p className="text-xs uppercase tracking-widest font-bold text-on-surface-variant">AI Ingested Packages</p>
          <p className="mt-2 text-3xl font-extrabold text-primary headline">
            {analyticsStats ? analyticsStats.uploads : metrics.totalUploads}
          </p>
        </div>
        <div className="bg-surface-container-lowest rounded-xl p-6 shadow-sm border border-surface-container-high">
          <p className="text-xs uppercase tracking-widest font-bold text-on-surface-variant">Completed vs Pending</p>
          <p className="mt-2 text-3xl font-extrabold text-primary headline">
            {analyticsStats ? `${analyticsStats.completed} / ${analyticsStats.pending}` : `${metrics.totalUploads} / 0`}
          </p>
        </div>
        <div className="bg-surface-container-lowest rounded-xl p-6 shadow-sm border border-surface-container-high">
          <p className="text-xs uppercase tracking-widest font-bold text-on-surface-variant">AI Ingest Success Rate</p>
          <p className="mt-2 text-3xl font-extrabold text-teal-600 headline">
            {analyticsStats ? `${analyticsStats.success_rate}%` : "100%"}
          </p>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 bg-surface-container-lowest rounded-xl p-6 border border-surface-container-high shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-bold text-primary headline">Upload Size (Lifetime)</h3>
            <div className="flex flex-wrap items-center gap-2">
              <select
                id="filter"
                className="rounded-md bg-surface-container-highest border border-surface-container-high px-2.5 py-1.5 text-xs font-semibold text-on-surface"
                value={uploadGrowthFilter}
                onChange={(event) => setUploadGrowthFilter(event.target.value)}
              >
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="month">This month</option>
                <option value="all">All time</option>
              </select>
              <input
                type="date"
                className="rounded-md bg-surface-container-highest border border-surface-container-high px-2.5 py-1.5 text-xs font-semibold text-on-surface"
                value={graphFromDate}
                onChange={(event) => setGraphFromDate(event.target.value)}
                aria-label="Graph start date"
              />
              <input
                type="date"
                className="rounded-md bg-surface-container-highest border border-surface-container-high px-2.5 py-1.5 text-xs font-semibold text-on-surface"
                value={graphToDate}
                onChange={(event) => setGraphToDate(event.target.value)}
                aria-label="Graph end date"
              />
            </div>
          </div>
          {dashboardInsights.points.length === 0 ? (
            <p className="mt-6 text-sm font-medium text-on-surface-variant">
              No uploads recorded yet.
            </p>
          ) : (
            <div className="mt-6 space-y-3">
              <div className="w-full rounded-lg bg-surface-container-low p-3">
                {(() => {
                  const chartWidth = 700;
                  const chartHeight = 180;
                  const leftPadding = 24;
                  const rightPadding = 18;
                  const topPadding = 14;
                  const bottomPadding = 20;
                  const usableWidth = chartWidth - leftPadding - rightPadding;
                  const usableHeight = chartHeight - topPadding - bottomPadding;
                  const divisor = Math.max(dashboardInsights.maxUploadSize, 1);
                  const dateIndexMap = new Map(dashboardInsights.dateKeys.map((dateKey, index) => [dateKey, index]));

                  const points = dashboardInsights.points.map((point) => {
                    const dateIndex = dateIndexMap.get(point.dateKey) || 0;
                    const x = leftPadding + (dateIndex * usableWidth) / Math.max(dashboardInsights.dateKeys.length - 1, 1);
                    const y = topPadding + ((divisor - point.size) / divisor) * usableHeight;
                    return { ...point, x, y };
                  });

                  return (
                    <svg className="w-full h-[200px]" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label="Upload size by date chart">
                      <line x1={leftPadding} y1={chartHeight - bottomPadding} x2={chartWidth - rightPadding} y2={chartHeight - bottomPadding} stroke="rgba(116,119,126,0.45)" strokeWidth="1" />

                      {points.map((point) => (
                        <g key={point.key}>
                          <circle cx={point.x} cy={point.y} r="3.2" fill="#0f766e" />
                          <title>{`${formatBytes(point.size)} on ${point.dateKey}`}</title>
                        </g>
                      ))}
                    </svg>
                  );
                })()}
              </div>

              <div className="flex items-center gap-4 text-[11px] font-bold text-on-surface-variant">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded-full bg-teal-700"></span>
                  <span>Each dot = one upload</span>
                </div>
              </div>

              <div className="flex items-center justify-between px-1">
                {dashboardInsights.dateKeys
                  .filter((_, index) => index % dashboardInsights.xAxisLabelStep === 0 || index === dashboardInsights.dateKeys.length - 1)
                  .map((point) => (
                    <div key={point} className="text-center">
                      <p className="text-[10px] font-semibold text-on-surface-variant">{point}</p>
                    </div>
                  ))}
              </div>

              <div className="text-xs font-semibold text-on-surface-variant space-y-1">
                <p>Total uploads (lifetime): {dashboardInsights.lifetimeUploadCount}</p>
                <p>Today total uploads: {dashboardInsights.todayUploadCount}</p>
                <p>Yesterday total uploads: {dashboardInsights.yesterdayUploadCount}</p>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="bg-surface-container-lowest rounded-xl p-6 border border-surface-container-high shadow-sm">
            <h3 className="text-sm font-bold text-primary headline">Bucket Distribution</h3>
            {dashboardInsights.bucketDistribution.length === 0 ? (
              <p className="mt-4 text-xs font-medium text-on-surface-variant">No bucket usage yet.</p>
            ) : (
              <div className="mt-4 space-y-3">
                {dashboardInsights.bucketDistribution.map((item) => {
                  const widthPercent = dashboardInsights.maxBucketBytes > 0
                    ? Math.max(8, Math.round((item.bytes / dashboardInsights.maxBucketBytes) * 100))
                    : 8;

                  return (
                    <div key={item.bucket}>
                      <div className="flex items-center justify-between text-[10px] font-bold text-on-surface-variant mb-1">
                        <span className="truncate max-w-[160px]" title={item.bucket}>{item.bucket}</span>
                        <span>{formatBytes(item.bytes)}</span>
                      </div>
                      <div className="h-2 rounded bg-surface-container-low overflow-hidden">
                        <div className="h-full rounded bg-teal-600" style={{ width: `${widthPercent}%` }}></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="bg-surface-container-lowest rounded-xl p-6 border border-surface-container-high shadow-sm">
            <h3 className="text-sm font-bold text-primary headline">Vault Status</h3>
            <div className="mt-4 space-y-2 text-xs text-on-surface-variant font-semibold">
              <div className="flex justify-between">
                <span>Buckets with uploads</span>
                <span>{metrics.uniqueUploadBuckets}</span>
              </div>
              <div className="flex justify-between">
                <span>Configured buckets</span>
                <span>{metrics.configuredBuckets}</span>
              </div>
              <div className="flex justify-between">
                <span>Most recent upload</span>
                <span>{metrics.latestUpload ? formatDate(metrics.latestUpload.created_at) : "-"}</span>
              </div>
            </div>
          </div>

          <div className="bg-surface-container-lowest rounded-xl p-6 border border-surface-container-high shadow-sm">
            <h3 className="text-sm font-bold text-primary headline">Quick Actions</h3>
            <div className="mt-4 flex flex-col gap-3">
              <button
                type="button"
                className="w-full rounded-lg bg-primary text-on-primary text-xs font-bold py-2.5"
                onClick={() => setActiveTab("upload")}
              >
                Go To Upload
              </button>
              <button
                type="button"
                className="w-full rounded-lg bg-surface-container-high text-primary text-xs font-bold py-2.5"
                onClick={() => setActiveTab("history")}
              >
                Open History
              </button>
              <button
                type="button"
                className="w-full rounded-lg bg-surface-container-high text-primary text-xs font-bold py-2.5"
                onClick={() => setActiveTab("buckets")}
              >
                Manage Buckets
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );

  const renderUploadCenter = () => (
    <main className="flex-1 w-full max-w-[1440px] mx-auto px-6 lg:px-10 py-10">
      {renderDataError}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 mt-4">
        <section className="xl:col-span-8 space-y-6">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tighter headline text-primary">Upload Center</h1>
            <p className="text-sm text-on-surface-variant font-medium mt-1">Upload files or folders with resumable chunk transfer.</p>
          </div>

          <div className="bg-surface-container-lowest rounded-xl p-4 border border-surface-container-high shadow-sm space-y-3">
            <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant">Upload Target Bucket</label>
            <select
              className="w-full rounded-lg bg-surface-container-highest border-none px-3 py-2.5 text-sm"
              value={selectedUploadBucket}
              onChange={(event) => setSelectedUploadBucket(event.target.value)}
            >
              <option value="">
                {(() => {
                  const defaultBucket = buckets.find((bucket) => bucket.system_default);
                  if (!defaultBucket) return "MediVault Bucket";
                  return `${defaultBucket.bucket_name} (${defaultBucket.region || "-"}) - Default`;
                })()}
              </option>
              {buckets.filter((bucket) => !bucket.system_default).map((bucket) => (
                <option key={bucket.id} value={bucket.bucket_name}>
                  {bucket.bucket_name} ({bucket.region || "-"})
                </option>
              ))}
            </select>
            <p className="text-xs text-on-surface-variant font-medium">
              New uploads will use the selected bucket. Resume uploads continue in their original bucket.
            </p>
          </div>

          <FileUploader
            file={file}
            onFileSelect={handleFileSelect}
            onFolderSelect={handleFolderSelect}
            status={status}
            onUpload={handleUpload}
            onPause={pause}
            onResume={resume}
            onCancel={handleCancel}
            onPreview={() => setShowPreview(true)}
            isPreparingFolder={isPreparingFolder}
          />

          <UploadStatus status={status} error={error} networkType={networkType} displayChunkMB={displayChunkMB} />

          {/* Predictive AI Telemetry card */}
          {status === "uploading" && predictiveTelemetry && (
            <div className="bg-teal-50/50 border border-teal-200/50 rounded-xl p-4 text-xs font-semibold text-teal-900 space-y-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 uppercase tracking-wider text-[10px] font-bold text-teal-800">
                  <span className="material-symbols-outlined text-xs">analytics</span>
                  Package AI Predictive Analysis
                </span>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                  predictiveTelemetry.network_health === "Critical" 
                    ? "bg-red-100 text-red-800" 
                    : predictiveTelemetry.network_health === "Unstable" 
                      ? "bg-yellow-100 text-yellow-800" 
                      : "bg-green-100 text-green-800"
                }`}>
                  {predictiveTelemetry.network_health}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Upload Failure Probability:</span>
                <span className="font-bold">{(predictiveTelemetry.failure_probability * 100).toFixed(0)}%</span>
              </div>
              <p className="text-[11px] font-medium text-teal-800/80 leading-relaxed italic">
                Recommendation: {predictiveTelemetry.recommendation}
              </p>
            </div>
          )}

          {(status === "uploading" || status === "paused" || status === "completed") && (
            <ProgressTracker
              progress={progress}
              chunkStatuses={chunkStatuses}
              status={status}
            />
          )}
        </section>

        <aside className="xl:col-span-4 space-y-4">
          <div className="bg-surface-container-lowest rounded-xl p-6 border border-surface-container-high shadow-sm">
            <h3 className="text-sm font-bold text-primary headline">Network Status</h3>
            {status === "uploading" ? (
              <div className="mt-4 space-y-2 text-xs font-semibold text-on-surface-variant">
                <div className="flex justify-between">
                  <span>Speed</span>
                  <span>{Number.isFinite(avgUploadSpeedMB) ? `${avgUploadSpeedMB.toFixed(2)} MB/s` : "Calculating..."}</span>
                </div>
                <div className="flex justify-between">
                  <span>Status</span>
                  <span>
                    {networkType === "Slow" ? "Slow 🐢" : networkType === "Medium" ? "Medium ⚡" : "Fast 🚀"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Adaptive Mode</span>
                  <span>ON</span>
                </div>
              </div>
            ) : (
              <p className="mt-4 text-xs font-semibold text-on-surface-variant">Idle</p>
            )}
          </div>

          <div className="bg-surface-container-lowest rounded-xl p-6 border border-surface-container-high shadow-sm">
            <h3 className="text-sm font-bold text-primary headline">Live Vault Metrics</h3>
            <div className="mt-4 space-y-3 text-xs font-semibold text-on-surface-variant">
              <div className="flex justify-between">
                <span>Total stored</span>
                <span>{formatBytes(metrics.totalUploadedBytes)}</span>
              </div>
              <div className="flex justify-between">
                <span>Total uploads</span>
                <span>{metrics.totalUploads}</span>
              </div>
              <div className="flex justify-between">
                <span>Configured buckets</span>
                <span>{metrics.configuredBuckets}</span>
              </div>
            </div>
          </div>

          <div className="bg-surface-container-lowest rounded-xl p-6 border border-surface-container-high shadow-sm">
            <h3 className="text-sm font-bold text-primary headline">Latest Activity</h3>
            {metrics.latestUpload ? (
              <div className="mt-4 text-xs font-medium text-on-surface-variant space-y-2">
                <p className="text-sm font-semibold text-primary truncate" title={metrics.latestUpload.filename}>{metrics.latestUpload.filename}</p>
                <p>Bucket: {metrics.latestUpload.bucket || "medivault-bucket"}</p>
                <p>Size: {formatBytes(Number(metrics.latestUpload.size || 0))}</p>
                <p>Time: {formatDate(metrics.latestUpload.created_at)}</p>
              </div>
            ) : (
              <p className="mt-4 text-xs text-on-surface-variant font-semibold">No upload history available yet.</p>
            )}
          </div>
        </aside>
      </div>
    </main>
  );

  const renderBuckets = () => (
    <main className="flex-1 w-full max-w-[1440px] mx-auto px-6 lg:px-10 py-10 space-y-6">
      {renderDataError}

      <div>
        <h1 className="text-3xl font-extrabold tracking-tighter headline text-primary">Buckets</h1>
        <p className="text-sm text-on-surface-variant font-medium mt-1">Validate and save S3 bucket credentials for this account.</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <section className="xl:col-span-5 bg-surface-container-lowest rounded-xl p-6 border border-surface-container-high shadow-sm">
          <h2 className="text-lg font-bold text-primary headline">Add Bucket</h2>
          <form className="mt-4 space-y-4" onSubmit={handleAddBucket}>
            <div>
              <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">Bucket Name</label>
              <input
                className={`w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm ${bucketFormTouched.bucket_name && bucketFormErrors.bucket_name ? "border border-error" : "border border-transparent"}`}
                value={bucketForm.bucket_name}
                onChange={(event) => handleBucketFieldChange("bucket_name", event.target.value)}
                onBlur={() => handleBucketFieldBlur("bucket_name")}
                placeholder="my-medical-bucket"
              />
              <p className="mt-1 text-[11px] text-on-surface-variant font-medium">Example: medivault-bucket-001</p>
              {bucketFormTouched.bucket_name && bucketFormErrors.bucket_name ? (
                <p className="mt-1 text-[11px] text-error font-semibold">{bucketFormErrors.bucket_name}</p>
              ) : null}
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">Region</label>
              <input
                className={`w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm ${bucketFormTouched.region && bucketFormErrors.region ? "border border-error" : "border border-transparent"}`}
                value={bucketForm.region}
                onChange={(event) => handleBucketFieldChange("region", event.target.value)}
                onBlur={() => handleBucketFieldBlur("region")}
                placeholder="ap-south-1"
                list="aws-region-suggestions"
              />
              <datalist id="aws-region-suggestions">
                <option value="ap-south-1" />
                <option value="ap-southeast-1" />
                <option value="us-east-1" />
                <option value="us-west-2" />
                <option value="eu-west-1" />
              </datalist>
              {bucketFormTouched.region && bucketFormErrors.region ? (
                <p className="mt-1 text-[11px] text-error font-semibold">{bucketFormErrors.region}</p>
              ) : null}
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">Size Limit (GB)</label>
              <input
                type="number"
                min="1"
                step="1"
                className={`w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm ${bucketFormTouched.size_limit_gb && bucketFormErrors.size_limit_gb ? "border border-error" : "border border-transparent"}`}
                value={bucketForm.size_limit_gb}
                onChange={(event) => handleBucketFieldChange("size_limit_gb", event.target.value)}
                onBlur={() => handleBucketFieldBlur("size_limit_gb")}
                placeholder="10"
              />
              {bucketFormTouched.size_limit_gb && bucketFormErrors.size_limit_gb ? (
                <p className="mt-1 text-[11px] text-error font-semibold">{bucketFormErrors.size_limit_gb}</p>
              ) : null}
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">AWS Access Key ID</label>
              <input
                className={`w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm ${bucketFormTouched.aws_access_key_id && bucketFormErrors.aws_access_key_id ? "border border-error" : "border border-transparent"}`}
                value={bucketForm.aws_access_key_id}
                onChange={(event) => handleBucketFieldChange("aws_access_key_id", event.target.value)}
                onBlur={() => handleBucketFieldBlur("aws_access_key_id")}
                placeholder="AKIA..."
              />
              {bucketFormTouched.aws_access_key_id && bucketFormErrors.aws_access_key_id ? (
                <p className="mt-1 text-[11px] text-error font-semibold">{bucketFormErrors.aws_access_key_id}</p>
              ) : null}
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-1">AWS Secret Access Key</label>
              <input
                type="password"
                className={`w-full rounded-lg bg-surface-container-highest px-3 py-2.5 text-sm ${bucketFormTouched.aws_secret_access_key && bucketFormErrors.aws_secret_access_key ? "border border-error" : "border border-transparent"}`}
                value={bucketForm.aws_secret_access_key}
                onChange={(event) => handleBucketFieldChange("aws_secret_access_key", event.target.value)}
                onBlur={() => handleBucketFieldBlur("aws_secret_access_key")}
                placeholder="Secret key"
              />
              {bucketFormTouched.aws_secret_access_key && bucketFormErrors.aws_secret_access_key ? (
                <p className="mt-1 text-[11px] text-error font-semibold">{bucketFormErrors.aws_secret_access_key}</p>
              ) : null}
            </div>

            <div className="rounded-lg border border-surface-container-high bg-surface-container-low p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">Bucket CORS Policy</p>
                <button
                  type="button"
                  onClick={handleCopyCorsPolicy}
                  className="rounded-md bg-surface-container-highest px-3 py-1.5 text-[11px] font-bold text-primary"
                >
                  Copy CORS Policy
                </button>
              </div>

              <p className="text-[11px] text-on-surface-variant font-medium">
                After saving a bucket, open AWS S3 bucket Permissions and paste this in Cross-origin resource sharing (CORS).
              </p>

              <ol className="list-decimal ml-4 space-y-1 text-[11px] text-on-surface-variant font-medium">
                <li>Open AWS Console and select your S3 bucket.</li>
                <li>Go to Permissions tab and find Cross-origin resource sharing (CORS).</li>
                <li>Click Edit, paste the policy, and save changes.</li>
                <li>Retry upload from this app.</li>
              </ol>

              <pre className="w-full overflow-x-auto rounded-md bg-surface-container-highest p-3 text-[11px] text-on-surface whitespace-pre-wrap">
                {S3_CORS_POLICY_TEMPLATE}
              </pre>
            </div>

            <button
              type="submit"
              disabled={bucketSaving}
              className="w-full rounded-lg bg-primary text-on-primary py-2.5 text-sm font-bold disabled:opacity-60"
            >
              {bucketSaving ? "Saving..." : "Validate And Save Bucket"}
            </button>
          </form>
        </section>

        <section className="xl:col-span-7 bg-surface-container-lowest rounded-xl border border-surface-container-high shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-surface-container-high">
            <h2 className="text-lg font-bold text-primary headline">Saved Buckets ({buckets.length})</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-on-surface-variant bg-surface-container-low/50">
                  <th className="px-6 py-4">Bucket</th>
                  <th className="px-6 py-4">Region</th>
                  <th className="px-6 py-4">Validation</th>
                  <th className="px-6 py-4 text-right">Actions</th>
                  <th className="px-6 py-4 text-right">Added At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-container-high/50">
                {buckets.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="px-6 py-10 text-sm text-on-surface-variant text-center font-medium">
                      No buckets have been saved yet.
                    </td>
                  </tr>
                ) : (
                  buckets.map((bucket) => (
                    <tr key={bucket.id} className="hover:bg-surface-container-low/30 transition-colors">
                      <td className="px-6 py-5 text-sm font-semibold text-primary">
                        {bucket.bucket_name}
                        {(() => {
                          const usage = bucketUsageByName[bucket.bucket_name];
                          const usedBytes = Number(usage?.used || 0);
                          const limitBytes = Number(usage?.limit || bucket.size_limit || 0);
                          const rawPercent = Number(usage?.percent || 0);
                          const clampedPercent = Math.max(0, Math.min(rawPercent, 100));
                          const status = usage?.status || "ok";

                          const barClass = status === "exceeded"
                            ? "bg-error"
                            : status === "warning"
                              ? "bg-warning"
                              : "bg-teal-600";

                          const messageClass = status === "exceeded"
                            ? "text-error"
                            : status === "warning"
                              ? "text-warning"
                              : "text-on-surface-variant";

                          return (
                            <div className="mt-2 space-y-1">
                              <div className="flex items-center justify-between text-[11px] font-semibold text-on-surface-variant">
                                <span>{formatBytes(usedBytes)} / {formatBytes(limitBytes)}</span>
                                <span>{rawPercent.toFixed(1)}%</span>
                              </div>
                              <div className="h-2 rounded bg-surface-container-low overflow-hidden">
                                <div className={`h-full rounded ${barClass}`} style={{ width: `${clampedPercent}%` }}></div>
                              </div>
                              {usage?.message ? (
                                <p className={`text-[11px] font-semibold ${messageClass}`}>{usage.message}</p>
                              ) : null}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-6 py-5 text-xs font-bold uppercase tracking-wide text-on-surface-variant">{bucket.region || "-"}</td>
                      <td className="px-6 py-5 text-xs font-bold uppercase tracking-wide">
                        {bucket.validation_status === "pending_network_validation" ? (
                          <span className="text-warning">Pending AWS Validation</span>
                        ) : (
                          <span className="text-teal-600">Verified</span>
                        )}
                      </td>
                      <td className="px-6 py-5 text-right">
                        {(() => {
                          const isSystemDefault = bucket.system_default || bucket.id === "default-medivault";
                          return (
                            <button
                              type="button"
                              onClick={() => handleDeleteBucket(bucket)}
                              disabled={isSystemDefault || bucketDeletingId === bucket.id}
                              className="rounded-lg bg-error-container text-error px-3 py-1.5 text-xs font-bold disabled:opacity-60"
                            >
                              {isSystemDefault ? "Default" : bucketDeletingId === bucket.id ? "Deleting..." : "Delete"}
                            </button>
                          );
                        })()}
                      </td>
                      <td className="px-6 py-5 text-xs text-on-surface-variant text-right font-medium">{formatDate(bucket.created_at)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );

  const renderHistory = () => (
    <main className="flex-1 w-full max-w-[1440px] mx-auto px-6 lg:px-10 py-10 space-y-6">
      {renderDataError}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tighter headline text-primary">History & AI Agent Search</h1>
          <p className="text-sm text-on-surface-variant font-medium mt-1">Complete upload records and natural language AI search agent.</p>
        </div>
      </div>

      <div className="bg-teal-50/70 border border-teal-200/50 rounded-xl p-5 flex flex-col md:flex-row gap-3 items-end shadow-sm">
        <div className="flex-1 w-full">
          <label className="block text-xs font-bold uppercase tracking-widest text-teal-800 mb-1.5 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm">smart_toy</span>
            AI Search Agent (Ask anything in natural language)
          </label>
          <input
            type="text"
            className="w-full rounded-lg bg-white border border-teal-200 px-3.5 py-2.5 text-sm text-teal-950 placeholder-teal-600/50 shadow-inner focus:outline-teal-600 font-semibold"
            placeholder="e.g., 'show completed packages', 'find MRI files', 'patient_mri_brain_scan', 'files larger than 10MB'"
            value={agentSearchQuery}
            onChange={(event) => setAgentSearchQuery(event.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAgentSearch()}
          />
        </div>
        <div className="flex gap-2 w-full md:w-auto">
          <button
            type="button"
            onClick={handleAgentSearch}
            disabled={agentSearching || !agentSearchQuery.trim()}
            className="w-full md:w-auto px-5 py-2.5 rounded-lg bg-teal-700 hover:bg-teal-800 text-white font-bold text-sm shadow-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {agentSearching ? "Analyzing..." : "Ask Search Agent"}
          </button>
          {agentSearchResults && (
            <button
              type="button"
              onClick={() => { setAgentSearchResults(null); setAgentSearchQuery(""); }}
              className="px-4 py-2.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-sm transition-all"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {agentSearchResults ? (
        renderHistoryTable(agentSearchResults, "No upload records found by Search Agent for your query.")
      ) : (
        renderHistoryTable(filteredHistoryRecords, "No upload records found for the selected search/filter.")
      )}
    </main>
  );

  if (!authReady) {
    return (
      <div className="bg-background text-on-surface min-h-screen flex flex-col items-center justify-center font-body">
        <header className="text-center mb-8">
          <div className="text-5xl mb-4">🏥</div>
          <h1 className="text-4xl font-extrabold tracking-tighter text-primary headline mb-2">
            MediVault
          </h1>
          <p className="text-on-surface-variant font-medium">Verifying session...</p>
        </header>
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  if (!token) {
    return (
      <div className="bg-background text-on-surface min-h-screen flex flex-col font-body">
        <Login
          onLogin={(authPayload) => {
            setAuthReady(false);
            setActiveTab("dashboard");
            setToken(authPayload?.access_token || getAccessToken());
          }}
        />
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  const tabs = [
    { key: "dashboard", label: "Dashboard" },
    { key: "upload", label: "Upload" },
    { key: "buckets", label: "Buckets" },
    { key: "history", label: "History" },
  ];

  return (
    <div className="bg-background text-on-surface min-h-screen flex flex-col font-body">
      <header className="sticky top-0 z-50 w-full bg-slate-50/90 backdrop-blur-2xl border-b border-surface-container-high">
        <div className="flex flex-col w-full max-w-[1440px] mx-auto px-6 lg:px-10 gap-4 py-4 headline tracking-tight antialiased">
          <div className="flex items-center justify-between gap-6">
            <div className="text-2xl font-extrabold tracking-tighter text-primary">MediVault</div>
            <div className="flex items-center gap-4" ref={userMenuRef}>
              {dataLoading ? <span className="text-xs font-bold text-on-surface-variant">Syncing...</span> : null}
              <button
                type="button"
                onClick={fetchWorkspaceData}
                className="px-3 py-2 rounded-lg bg-surface-container-low text-xs font-bold text-primary"
              >
                Refresh
              </button>

              <div className="relative">
                <button
                  type="button"
                  onClick={handleToggleUserMenu}
                  className="flex items-center gap-2 p-2 rounded-lg bg-surface-container-low hover:bg-surface-container-high transition-all"
                  aria-haspopup="menu"
                  aria-expanded={userMenuOpen}
                  title="Open user menu"
                >
                  <span className="text-xs font-bold text-primary">{currentUser?.username || "User"}</span>
                  <span className="material-symbols-outlined text-xl">account_circle</span>
                </button>

                {userMenuOpen ? (
                  <div className="absolute right-0 mt-2 w-72 rounded-xl border border-surface-container-high bg-surface-container-lowest shadow-lg p-2 z-50">
                    <button
                      type="button"
                      onClick={handleShowUserDetails}
                      className="w-full text-left rounded-lg px-3 py-2 text-sm font-bold text-primary hover:bg-surface-container-low"
                    >
                      User Details
                    </button>

                    {showUserDetails ? (
                      <div className="mx-1 mt-2 rounded-lg bg-surface-container-low p-3 text-xs text-on-surface-variant font-semibold space-y-2">
                        <div className="flex justify-between gap-4">
                          <span>Username</span>
                          <span className="text-primary truncate max-w-[130px]" title={currentUser?.username || "User"}>
                            {currentUser?.username || "User"}
                          </span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>Configured Buckets</span>
                          <span className="text-primary">{metrics.configuredBuckets}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>Total Uploads</span>
                          <span className="text-primary">{metrics.totalUploads}</span>
                        </div>
                      </div>
                    ) : null}

                    <button
                      type="button"
                      onClick={handleLogout}
                      className="mt-2 w-full text-left rounded-lg px-3 py-2 text-sm font-bold text-error hover:bg-error-container"
                    >
                      Logout
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <nav className="flex items-center gap-2 overflow-x-auto">
            {tabs.map((tab) => {
              const isActive = tab.key === activeTab;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${isActive
                    ? "bg-primary text-on-primary"
                    : "bg-surface-container-low text-on-surface-variant hover:text-primary"
                    }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      {activeTab === "dashboard" ? renderDashboard() : null}
      {activeTab === "upload" ? renderUploadCenter() : null}
      {activeTab === "buckets" ? renderBuckets() : null}
      {activeTab === "history" ? renderHistory() : null}

      {showPreview && file && (
        <FilePreviewModal
          file={file}
          onClose={() => setShowPreview(false)}
        />
      )}

      {activeSummary && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-slate-200 flex flex-col max-h-[90vh] text-left">
            <div className="flex items-center justify-between border-b pb-4">
              <div>
                <span className="bg-teal-100 text-teal-800 text-xs font-extrabold px-2.5 py-1 rounded-full uppercase tracking-wider">
                  {activeSummary.category || "Report Analysis"}
                </span>
                <h3 className="text-xl font-extrabold text-slate-900 mt-2">AI Clinical Summary</h3>
              </div>
              <button
                type="button"
                onClick={() => setActiveSummary(null)}
                className="text-slate-400 hover:text-slate-600 text-2xl font-bold"
              >
                &times;
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto py-6 space-y-6">
              <div>
                <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">Executive Summary</h4>
                <p className="text-sm font-medium leading-relaxed text-slate-800 bg-slate-50 rounded-xl p-4 border border-slate-100">
                  {activeSummary.summary || "No summary text generated."}
                </p>
              </div>
              
              <div>
                <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">Key Clinical Insights</h4>
                <ul className="space-y-2.5">
                  {activeSummary.insights && activeSummary.insights.length > 0 ? (
                    activeSummary.insights.map((insight, idx) => (
                      <li key={idx} className="flex gap-3 text-sm text-slate-700 font-medium">
                        <span className="text-teal-600 font-bold">✓</span>
                        <span>{insight}</span>
                      </li>
                    ))
                  ) : (
                    <li className="text-sm text-slate-400 italic">No key insights extracted.</li>
                  )}
                </ul>
              </div>
            </div>
            
            <div className="border-t pt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setActiveSummary(null)}
                className="bg-slate-950 text-white font-bold px-5 py-2.5 rounded-lg text-sm hover:bg-slate-800 transition-colors"
              >
                Close Analysis
              </button>
            </div>
          </div>
        </div>
      )}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export default App;
