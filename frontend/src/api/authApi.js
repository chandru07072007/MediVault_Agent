import axios from "axios";
import {
  clearAuthSession,
  getStoredAccessToken,
  getStoredAccessTokenExpiry,
  saveAuthSession,
} from "../utils/storage";
import { AUTH_API_BASE } from "./apiConfig";

const api = axios.create({
  baseURL: AUTH_API_BASE,
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
});

const refreshClient = axios.create({
  baseURL: AUTH_API_BASE,
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
});

let refreshPromise = null;
let onAuthFailure = null;

function attachAuthorizationHeader(config) {
  const token = getStoredAccessToken();
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
}

async function ensureFreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = refreshAccessToken().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export function setAuthFailureHandler(handler) {
  onAuthFailure = typeof handler === "function" ? handler : null;
}

export function getAccessToken() {
  return getStoredAccessToken();
}

export function getAccessTokenExpiryEpochMs() {
  return getStoredAccessTokenExpiry();
}

api.interceptors.request.use((config) => {
  config.withCredentials = true;
  return attachAuthorizationHeader(config);
});

api.interceptors.response.use(undefined, async (error) => {
  const status = error?.response?.status;
  const originalRequest = error?.config;

  if (!originalRequest || (status !== 401 && status !== 403)) {
    return Promise.reject(error);
  }

  if (originalRequest._retry || originalRequest._skipAuthRefresh) {
    return Promise.reject(error);
  }

  originalRequest._retry = true;

  try {
    await ensureFreshAccessToken();
    attachAuthorizationHeader(originalRequest);
    return api.request(originalRequest);
  } catch (refreshError) {
    clearAuthSession();
    if (onAuthFailure) {
      onAuthFailure(refreshError);
    }
    return Promise.reject(error);
  }
});

export async function loginUser(username, password) {
  const { data } = await api.post(
    "/login",
    { username, password },
    { _skipAuthRefresh: true },
  );
  if (data?.access_token) {
    saveAuthSession(data.access_token, data.expires_in);
  }
  return data;
}

export async function registerUser(username, password) {
  const { data } = await api.post(
    "/register",
    { username, password },
    { _skipAuthRefresh: true },
  );
  return data;
}

export async function getCurrentUser() {
  const { data } = await api.get("/me");
  return data;
}

export async function refreshAccessToken() {
  const { data } = await refreshClient.post(
    "/refresh",
    {},
    { _skipAuthRefresh: true },
  );

  if (data?.access_token) {
    saveAuthSession(data.access_token, data.expires_in);
  }

  return data;
}

export async function logoutUser() {
  try {
    await api.post("/logout", {}, { _skipAuthRefresh: true });
  } finally {
    clearAuthSession();
  }
}

export function attachAuthInterceptors(client) {
  client.interceptors.request.use((config) => {
    config.withCredentials = true;
    return attachAuthorizationHeader(config);
  });

  client.interceptors.response.use(undefined, async (error) => {
    const status = error?.response?.status;
    const originalRequest = error?.config;

    if (!originalRequest || (status !== 401 && status !== 403)) {
      return Promise.reject(error);
    }

    if (originalRequest._retry || originalRequest._skipAuthRefresh) {
      return Promise.reject(error);
    }

    originalRequest._retry = true;

    try {
      await ensureFreshAccessToken();
      attachAuthorizationHeader(originalRequest);
      return client.request(originalRequest);
    } catch (refreshError) {
      clearAuthSession();
      if (onAuthFailure) {
        onAuthFailure(refreshError);
      }
      return Promise.reject(error);
    }
  });
}
