import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { api, setUnauthorizedHandler } from "./api.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      const data = await api.get("/api/me");
      setUser(data.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      // path-aware so this never yanks a /super/login visitor over to the
      // salesman login (this fires even on the routine "am I logged in?"
      // check every page does on load, not just genuine session expiry)
      const loginPath = window.location.pathname.startsWith("/super") ? "/super/login" : "/login";
      navigate(loginPath, { replace: true });
    });
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async (mobile, password) => {
    const data = await api.post("/api/login", { json: { mobile, password } });
    setUser(data.user);
    return data.user;
  };

  const superLogin = async (password) => {
    const data = await api.post("/api/super/login", { json: { password } });
    setUser(data.user);
    return data.user;
  };

  const logout = async () => {
    const wasSuperadmin = user?.role === "superadmin";
    try {
      await api.post("/api/logout");
    } catch {
      // ignore — clearing local state is what matters
    }
    setUser(null);
    navigate(wasSuperadmin ? "/super/login" : "/login", { replace: true });
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, superLogin, logout, refresh }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

export function RequireAuth({ children, roles, loginPath = "/login" }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="state-block">
        <span className="spinner-inline" /> Loading…
      </div>
    );
  }
  if (!user) {
    return <Navigate to={loginPath} state={{ from: location }} replace />;
  }
  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }
  return children;
}
