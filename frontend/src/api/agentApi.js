import axios from "axios";
import { attachAuthInterceptors } from "./authApi";
import { AGENT_API_BASE } from "./apiConfig";

const api = axios.create({
  baseURL: AGENT_API_BASE,
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
});

attachAuthInterceptors(api);

export async function runAgent(task, data) {
  const { data: responseData } = await api.post("/agent", { task, data });
  return responseData;
}
