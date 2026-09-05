import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth.jsx";

export default function SuperLogin() {
  const { superLogin } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await superLogin(password);
      navigate("/super", { replace: true });
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
        <div className="logo-sub">Superadmin</div>
      </div>
      <div className="login-tagline">Shop management</div>
      <form className="login-form" onSubmit={handleSubmit}>
        {error ? <div className="login-error">{error}</div> : null}
        <div className="field">
          <label>Password</label>
          <input
            type="password"
            autoFocus
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
