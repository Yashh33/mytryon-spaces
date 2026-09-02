import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth.jsx";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobile, setMobile] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await login(mobile.trim(), password);
      const from = location.state?.from?.pathname || "/";
      navigate(from, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="logo-block">
        <div className="logo-name">Reflection</div>
        <div className="logo-sub">Lifestyle</div>
      </div>
      <div className="login-tagline">Visualization tool</div>
      <form className="login-form" onSubmit={handleSubmit}>
        {error ? <div className="login-error">{error}</div> : null}
        <div className="field">
          <label>Mobile number</label>
          <input
            type="tel"
            inputMode="numeric"
            autoComplete="username"
            required
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Password</label>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button className="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
