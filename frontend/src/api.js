export class ApiError extends Error {
  constructor(message, status, error) {
    super(message);
    this.status = status;
    this.error = error;
  }
}

let unauthorizedHandler = null;

export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

async function request(method, path, { json, form } = {}) {
  const opts = { method, credentials: "include" };
  if (json !== undefined) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(json);
  } else if (form !== undefined) {
    opts.body = form;
  }

  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError("You seem to be offline. Please check your connection.", 0, "network_error");
  }

  if (res.status === 401 && path !== "/api/login") {
    if (unauthorizedHandler) unauthorizedHandler();
    throw new ApiError("Please sign in again.", 401, "unauthorized");
  }

  let data = null;
  let body = "";
  try {
    body = await res.text();
    data = body ? JSON.parse(body) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    let message = data && (data.message || data.detail);
    if (!message && res.status === 413) message = "The photo is too large for the server to accept. Please choose a smaller photo.";
    if (!message) {
      // not our JSON (e.g. a proxy's error page): say what came back
      const text = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
      message = `Something went wrong (error ${res.status}${text ? `: ${text}` : ""}). Please try again.`;
    }
    throw new ApiError(message, res.status, data && data.error);
  }
  return data;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body),
  patch: (path, body) => request("PATCH", path, body),
  put: (path, body) => request("PUT", path, body),
  del: (path) => request("DELETE", path),
};
